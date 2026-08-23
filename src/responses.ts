// OpenAI Responses API protocol adapter.
// Maps POST /v1/responses <-> traecli exec.
//
// Request shape (subset we support):
//   { model?, instructions?, input: string | InputItem[], stream? }
// where InputItem is { role, content } and content is a string or an array of
// parts ({type:"input_text"|"output_text"|"text", text}).
//
// Non-streaming response: a `response` object with an `output` array containing
// one assistant `message` item, plus a convenience `output_text` string.
// Streaming: the response.* SSE event sequence.

import type { Config } from "./config.ts";
import type { TraeEvent, TraeUsage } from "./traecli.ts";
import { runRawChat } from "./rawchat.ts";
import {
  buildTranscript,
  estimateTokens,
  newId,
  nowUnix,
  type ChatMessage,
  type ToolCall,
  type ToolDef,
} from "./transcript.ts";

interface ResponsesContentPart {
  type?: string;
  text?: string;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  // function_call item (assistant asked for a tool)
  call_id?: string;
  name?: string;
  arguments?: string;
  id?: string;
  // function_call_output item (tool result)
  output?: string;
}

interface ResponsesToolDef {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: ResponsesToolDef[];
  stream?: boolean;
}

/** Flatten Responses content (string or typed parts) to plain text. */
function partsToText(content: string | ResponsesContentPart[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p && (p.type === undefined || p.type.endsWith("text")))
    .map((p) => p.text ?? "")
    .join("");
}

export function parseResponsesRequest(body: unknown): {
  model?: string;
  system: string | null;
  messages: ChatMessage[];
  tools: ToolDef[];
  stream: boolean;
} {
  const req = body as ResponsesRequest;
  if (!req || req.input === undefined || req.input === null) {
    throw new Error("invalid request: `input` is required");
  }

  const systemParts: string[] = [];
  if (typeof req.instructions === "string" && req.instructions.trim()) {
    systemParts.push(req.instructions);
  }

  const messages: ChatMessage[] = [];
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      // Tool call the model made on a prior turn.
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: "",
          toolCalls: [
            { id: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: item.arguments ?? "{}" },
          ],
        });
        continue;
      }
      // Result of executing that tool call.
      if (item.type === "function_call_output") {
        messages.push({ role: "tool", content: item.output ?? "", toolCallId: item.call_id ?? "" });
        continue;
      }
      const text = partsToText(item.content);
      const role = item.role ?? "user";
      if (role === "system" || role === "developer") {
        if (text.trim()) systemParts.push(text);
      } else {
        messages.push({ role, content: text });
      }
    }
  } else {
    throw new Error("invalid request: `input` must be a string or an array");
  }

  // Responses tools are flat: {type:"function", name, description, parameters}.
  const tools: ToolDef[] = Array.isArray(req.tools)
    ? req.tools
        .filter((t) => t.name)
        .map((t) => ({ name: t.name!, description: t.description, parameters: t.parameters }))
    : [];

  return {
    model: req.model,
    system: systemParts.length ? systemParts.join("\n\n") : null,
    messages,
    tools,
    stream: req.stream === true,
  };
}

function toResponsesUsage(usage: TraeUsage, promptFallback: number) {
  const input = usage.input_tokens || promptFallback;
  const output = usage.output_tokens;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cached_input_tokens },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage.reasoning_output_tokens },
    total_tokens: input + output,
  };
}

/** Assemble a full `response` object (used for both non-stream and terminal stream event). */
function buildResponse(
  id: string,
  model: string,
  text: string,
  reasoning: string,
  status: "completed" | "in_progress",
  usage: ReturnType<typeof toResponsesUsage> | null,
  msgId: string,
  reasoningId: string,
  toolCalls: ToolCall[] = [],
) {
  const output: Array<Record<string, unknown>> = [];
  if (status === "completed") {
    if (reasoning) {
      output.push({
        type: "reasoning",
        id: reasoningId,
        summary: [{ type: "summary_text", text: reasoning }],
      });
    }
    if (text) {
      output.push({
        type: "message",
        id: msgId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      });
    }
    for (const c of toolCalls) {
      output.push({
        type: "function_call",
        id: newId("fc"),
        call_id: c.id,
        name: c.name,
        arguments: c.arguments || "{}",
        status: "completed",
      });
    }
  }
  return {
    id,
    object: "response",
    created_at: nowUnix(),
    status,
    error: null,
    incomplete_details: null,
    model,
    output,
    output_text: status === "completed" ? text : "",
    usage,
  };
}

export async function handleResponsesNonStream(
  cfg: Config,
  parsed: ReturnType<typeof parseResponsesRequest>,
  rid?: string,
): Promise<object> {
  const prompt = buildTranscript(parsed.system, parsed.messages);
  const model = parsed.model || cfg.defaultModel;
  const res = await runRawChat(cfg, {
    system: parsed.system,
    messages: parsed.messages,
    model: parsed.model,
    tools: parsed.tools,
    rid,
  });
  return buildResponse(
    newId("resp"),
    model,
    res.text,
    cfg.reasoning ? res.reasoning : "",
    "completed",
    toResponsesUsage(res.usage, estimateTokens(prompt)),
    newId("msg"),
    newId("rs"),
    res.toolCalls,
  );
}

// --- Streaming (SSE) ---
// Emit the response.* event sequence. traecli has no token deltas, so text is
// delivered as one (or few) output_text.delta events.

export interface SSEWriter {
  write: (data: string) => void;
  end: () => void;
}

export async function handleResponsesStream(
  cfg: Config,
  parsed: ReturnType<typeof parseResponsesRequest>,
  sse: SSEWriter,
  signal: AbortSignal,
  rid?: string,
): Promise<void> {
  const prompt = buildTranscript(parsed.system, parsed.messages);
  const model = parsed.model || cfg.defaultModel;
  const id = newId("resp");
  const msgId = newId("msg");
  const reasoningId = newId("rs");

  let seq = 0;
  const send = (event: string, data: Record<string, unknown>) => {
    sse.write(
      `event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number: seq++ })}\n\n`,
    );
  };

  send("response.created", {
    type: "response.created",
    response: buildResponse(id, model, "", "", "in_progress", null, msgId, reasoningId),
  });
  send("response.in_progress", {
    type: "response.in_progress",
    response: buildResponse(id, model, "", "", "in_progress", null, msgId, reasoningId),
  });

  // Two output items open lazily and in order: reasoning (if any) then message.
  let outputIndex = -1;
  let reasoningIndex = -1;
  let msgIndex = -1;
  const reasoningChunks: string[] = [];
  const textChunks: string[] = [];
  const toolCalls: ToolCall[] = [];

  const openReasoning = () => {
    reasoningIndex = ++outputIndex;
    send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: reasoningIndex,
      item: { type: "reasoning", id: reasoningId, summary: [] },
    });
    send("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: reasoningId,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  };

  const closeReasoning = () => {
    if (reasoningIndex < 0) return;
    const full = reasoningChunks.join("");
    send("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: reasoningId,
      output_index: reasoningIndex,
      summary_index: 0,
      text: full,
    });
    send("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: reasoningId,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: full },
    });
    send("response.output_item.done", {
      type: "response.output_item.done",
      output_index: reasoningIndex,
      item: { type: "reasoning", id: reasoningId, summary: [{ type: "summary_text", text: full }] },
    });
  };

  const openMessage = () => {
    msgIndex = ++outputIndex;
    send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: msgIndex,
      item: { type: "message", id: msgId, status: "in_progress", role: "assistant", content: [] },
    });
    send("response.content_part.added", {
      type: "response.content_part.added",
      item_id: msgId,
      output_index: msgIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  // A tool call is its own output item. rawchat accumulates the arguments, so we
  // add the item, stream the full args as one delta, then mark it done.
  let closedReasoning = false;
  const emitToolCall = (call: ToolCall) => {
    if (reasoningIndex >= 0 && msgIndex < 0 && !closedReasoning) {
      closeReasoning();
      closedReasoning = true;
    }
    toolCalls.push(call);
    const fcId = newId("fc");
    const fcIndex = ++outputIndex;
    const args = call.arguments && call.arguments.trim() ? call.arguments : "{}";
    send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: fcIndex,
      item: { type: "function_call", id: fcId, call_id: call.id, name: call.name, arguments: "", status: "in_progress" },
    });
    send("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: fcId,
      output_index: fcIndex,
      delta: args,
    });
    send("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: fcId,
      output_index: fcIndex,
      arguments: args,
    });
    send("response.output_item.done", {
      type: "response.output_item.done",
      output_index: fcIndex,
      item: { type: "function_call", id: fcId, call_id: call.id, name: call.name, arguments: args, status: "completed" },
    });
  };

  const onEvent = (ev: TraeEvent) => {
    if (ev.kind === "reasoning" && cfg.reasoning && ev.text) {
      if (reasoningIndex < 0) openReasoning();
      reasoningChunks.push(ev.text);
      send("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: reasoningId,
        output_index: reasoningIndex,
        summary_index: 0,
        delta: ev.text,
      });
    } else if (ev.kind === "message" && ev.text) {
      if (reasoningIndex >= 0 && msgIndex < 0 && !closedReasoning) {
        closeReasoning();
        closedReasoning = true;
      }
      if (msgIndex < 0) openMessage();
      textChunks.push(ev.text);
      send("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: msgId,
        output_index: msgIndex,
        content_index: 0,
        delta: ev.text,
      });
    } else if (ev.kind === "tool_call") {
      emitToolCall(ev.call);
    }
  };

  try {
    const res = await runRawChat(cfg, {
      system: parsed.system,
      messages: parsed.messages,
      model: parsed.model,
      tools: parsed.tools,
      onEvent,
      signal,
      rid,
    });
    // Close a reasoning item that never got a following message event.
    if (reasoningIndex >= 0 && msgIndex < 0 && !closedReasoning) closeReasoning();
    // Emit the text message item only when there is text (or as a fallback when
    // there were neither text deltas nor tool calls). A tool-only turn has none.
    const hadToolCalls = toolCalls.length > 0;
    if (msgIndex >= 0 || (!hadToolCalls && textChunks.length === 0)) {
      if (msgIndex < 0) {
        openMessage();
        if (res.text) {
          textChunks.push(res.text);
          send("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: msgId,
            output_index: msgIndex,
            content_index: 0,
            delta: res.text,
          });
        }
      }
      const full = textChunks.join("");
      send("response.output_text.done", {
        type: "response.output_text.done",
        item_id: msgId,
        output_index: msgIndex,
        content_index: 0,
        text: full,
      });
      send("response.content_part.done", {
        type: "response.content_part.done",
        item_id: msgId,
        output_index: msgIndex,
        content_index: 0,
        part: { type: "output_text", text: full, annotations: [] },
      });
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: msgIndex,
        item: {
          type: "message",
          id: msgId,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: full, annotations: [] }],
        },
      });
    }
    send("response.completed", {
      type: "response.completed",
      response: buildResponse(
        id,
        model,
        textChunks.join(""),
        reasoningChunks.join(""),
        "completed",
        toResponsesUsage(res.usage, estimateTokens(prompt)),
        msgId,
        reasoningId,
        toolCalls,
      ),
    });
  } catch (err) {
    send("response.failed", {
      type: "response.failed",
      response: {
        ...buildResponse(id, model, "", "", "in_progress", null, msgId, reasoningId),
        status: "failed",
        error: { code: "server_error", message: (err as Error).message },
      },
    });
  } finally {
    sse.end();
  }
}
