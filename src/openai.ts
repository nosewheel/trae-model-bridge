// OpenAI Chat Completions protocol adapter.
// Maps POST /v1/chat/completions <-> traecli exec.

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

interface OpenAIContentPart {
  type?: string;
  text?: string;
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolDef {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  stream?: boolean;
}

/** Flatten OpenAI content (string or multimodal parts) to plain text. */
function contentToText(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p && (p.type === undefined || p.type === "text"))
    .map((p) => p.text ?? "")
    .join("");
}

export function parseOpenAIRequest(body: unknown): {
  model?: string;
  system: string | null;
  messages: ChatMessage[];
  tools: ToolDef[];
  stream: boolean;
} {
  const req = body as OpenAIChatRequest;
  if (!req || !Array.isArray(req.messages)) {
    throw new Error("invalid request: `messages` array is required");
  }
  const systemParts: string[] = [];
  const messages: ChatMessage[] = [];
  for (const m of req.messages) {
    const text = contentToText(m.content);
    if (m.role === "system" || m.role === "developer") {
      if (text.trim()) systemParts.push(text);
    } else if (m.role === "tool") {
      messages.push({ role: "tool", content: text, toolCallId: m.tool_call_id ?? "" });
    } else if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      messages.push({
        role: "assistant",
        content: text,
        toolCalls: m.tool_calls.map((c) => ({
          id: c.id ?? "",
          name: c.function?.name ?? "",
          arguments: c.function?.arguments ?? "{}",
        })),
      });
    } else {
      messages.push({ role: m.role, content: text });
    }
  }
  const tools: ToolDef[] = Array.isArray(req.tools)
    ? req.tools
        .filter((t) => t.function?.name)
        .map((t) => ({
          name: t.function!.name!,
          description: t.function!.description,
          parameters: t.function!.parameters,
        }))
    : [];
  return {
    model: req.model,
    system: systemParts.length ? systemParts.join("\n\n") : null,
    messages,
    tools,
    stream: req.stream === true,
  };
}

function toOpenAIUsage(usage: TraeUsage, promptFallback: number) {
  const prompt = usage.input_tokens || promptFallback;
  const completion = usage.output_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    // Extra detail, ignored by strict clients.
    prompt_tokens_details: { cached_tokens: usage.cached_input_tokens },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoning_output_tokens,
    },
  };
}

/** Build a non-streaming ChatCompletion object. */
export function buildChatCompletion(
  model: string,
  text: string,
  reasoning: string,
  toolCalls: ToolCall[],
  usage: TraeUsage,
  promptText: string,
) {
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  // reasoning_content is the de-facto field for exposing thinking on
  // OpenAI-compatible endpoints (DeepSeek, vLLM, OpenRouter, ...).
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((c, i) => ({
      index: i,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments || "{}" },
    }));
  }
  return {
    id: newId("chatcmpl"),
    object: "chat.completion",
    created: nowUnix(),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
    usage: toOpenAIUsage(usage, estimateTokens(promptText)),
  };
}

/** Handle a non-streaming request; returns the JSON body to send. */
export async function handleOpenAINonStream(
  cfg: Config,
  parsed: ReturnType<typeof parseOpenAIRequest>,
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
  return buildChatCompletion(
    model,
    res.text,
    cfg.reasoning ? res.reasoning : "",
    res.toolCalls,
    res.usage,
    prompt,
  );
}

// --- Streaming (SSE) ---
// traecli exec --json has no token deltas, so we stream coarse chunks: an
// initial role chunk, the full message as one content delta, then [DONE].

export interface SSEWriter {
  write: (data: string) => void;
  end: () => void;
}

export async function handleOpenAIStream(
  cfg: Config,
  parsed: ReturnType<typeof parseOpenAIRequest>,
  sse: SSEWriter,
  signal: AbortSignal,
  rid?: string,
): Promise<void> {
  const prompt = buildTranscript(parsed.system, parsed.messages);
  const model = parsed.model || cfg.defaultModel;
  const id = newId("chatcmpl");
  const created = nowUnix();

  const base = { id, object: "chat.completion.chunk", created, model };
  const sendChunk = (delta: object, finish: string | null = null) => {
    sse.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      })}\n\n`,
    );
  };

  // Open the stream with the assistant role.
  sendChunk({ role: "assistant", content: "" });

  let streamedAny = false;
  let toolIndex = 0;
  let sawToolCall = false;
  const onEvent = (ev: TraeEvent) => {
    if (ev.kind === "reasoning" && cfg.reasoning && ev.text) {
      sendChunk({ reasoning_content: ev.text });
    } else if (ev.kind === "message" && ev.text) {
      streamedAny = true;
      sendChunk({ content: ev.text });
    } else if (ev.kind === "tool_call") {
      sawToolCall = true;
      // Emit the whole call in one tool_calls delta (id+name+full arguments).
      sendChunk({
        tool_calls: [
          {
            index: toolIndex,
            id: ev.call.id,
            type: "function",
            function: { name: ev.call.name, arguments: ev.call.arguments || "{}" },
          },
        ],
      });
      toolIndex++;
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
    // If no message event streamed, emit the final text as a single delta.
    if (!streamedAny && !sawToolCall && res.text) sendChunk({ content: res.text });
    sendChunk({}, sawToolCall ? "tool_calls" : "stop");
    // Final usage chunk (OpenAI streaming usage extension).
    sse.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [],
        usage: toOpenAIUsage(res.usage, estimateTokens(prompt)),
      })}\n\n`,
    );
    sse.write("data: [DONE]\n\n");
  } catch (err) {
    sendChunk({ content: `\n[bridge error] ${(err as Error).message}` }, "stop");
    sse.write("data: [DONE]\n\n");
  } finally {
    sse.end();
  }
}
