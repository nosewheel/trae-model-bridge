// Anthropic Messages protocol adapter.
// Maps POST /v1/messages <-> traecli exec, so Claude Code can point at the bridge.

import type { Config } from "./config.ts";
import type { TraeEvent, TraeUsage } from "./traecli.ts";
import { runRawChat } from "./rawchat.ts";
import {
  buildTranscript,
  estimateTokens,
  newId,
  type ChatMessage,
  type ToolCall,
  type ToolDef,
} from "./transcript.ts";

// Anthropic thinking blocks carry a signature the API uses to verify them on
// replay. We synthesize one; some clients won't render a thinking block whose
// signature is empty. It's a non-empty opaque placeholder, not a real Anthropic
// signature (the bridge never round-trips thinking back to the model).
const THINKING_SIGNATURE = Buffer.from("trae-model-bridge-synthetic-signature").toString("base64");

/** Split text into small pieces so SSE deltas arrive incrementally. */
function chunkText(text: string, size = 24): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  // tool_use block (assistant): a tool the model wants to call.
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block (user): the output of a prior tool_use.
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface AnthropicRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
  stream?: boolean;
  max_tokens?: number;
}

function blocksToText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && (b.type === undefined || b.type === "text"))
    .map((b) => b.text ?? "")
    .join("");
}

/** Flatten a tool_result block's content (string or text parts) to plain text. */
function toolResultText(content: string | AnthropicContentBlock[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b.text ?? ""))
    .join("");
}

/**
 * Parse a Messages request into our protocol-agnostic shape. Anthropic encodes
 * tool calls/results as content blocks inside user/assistant messages; we lift
 * them into ChatMessage.toolCalls / role:"tool" turns so rawchat can pass them
 * through.
 */
export function parseAnthropicRequest(body: unknown): {
  model?: string;
  system: string | null;
  messages: ChatMessage[];
  tools: ToolDef[];
  stream: boolean;
} {
  const req = body as AnthropicRequest;
  if (!req || !Array.isArray(req.messages)) {
    throw new Error("invalid request: `messages` array is required");
  }
  const system = req.system ? blocksToText(req.system) : null;

  const messages: ChatMessage[] = [];
  for (const m of req.messages) {
    const blocks = Array.isArray(m.content) ? m.content : null;
    if (!blocks) {
      messages.push({ role: m.role, content: blocksToText(m.content) });
      continue;
    }
    // A single Anthropic message can mix text, tool_use and tool_result blocks.
    const toolResults = blocks.filter((b) => b?.type === "tool_result");
    const toolUses = blocks.filter((b) => b?.type === "tool_use");
    const text = blocksToText(blocks);

    if (m.role === "assistant" && toolUses.length) {
      messages.push({
        role: "assistant",
        content: text,
        toolCalls: toolUses.map((b) => ({
          id: b.id ?? "",
          name: b.name ?? "",
          arguments: JSON.stringify(b.input ?? {}),
        })),
      });
      continue;
    }
    if (toolResults.length) {
      // Each tool_result becomes its own role:"tool" turn (upstream keys on id).
      for (const tr of toolResults) {
        messages.push({
          role: "tool",
          content: toolResultText(tr.content),
          toolCallId: tr.tool_use_id ?? "",
        });
      }
      // Any accompanying free text becomes a normal user turn.
      if (text.trim()) messages.push({ role: "user", content: text });
      continue;
    }
    messages.push({ role: m.role, content: text });
  }

  const tools: ToolDef[] = Array.isArray(req.tools)
    ? req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }))
    : [];

  return {
    model: req.model,
    system: system && system.trim() ? system : null,
    messages,
    tools,
    stream: req.stream === true,
  };
}

function toAnthropicUsage(usage: TraeUsage, promptFallback: number) {
  return {
    input_tokens: usage.input_tokens || promptFallback,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cached_input_tokens,
  };
}

/** Parse a tool-call arguments JSON string into an object for Anthropic `input`. */
function parseToolInput(args: string): unknown {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

/** Build a non-streaming Messages response object. */
export function buildAnthropicMessage(
  model: string,
  text: string,
  reasoning: string,
  toolCalls: ToolCall[],
  usage: TraeUsage,
  promptText: string,
) {
  const content: Array<Record<string, unknown>> = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: THINKING_SIGNATURE });
  if (text) content.push({ type: "text", text });
  for (const c of toolCalls) {
    content.push({ type: "tool_use", id: c.id, name: c.name, input: parseToolInput(c.arguments) });
  }
  // A message must have at least one block; emit an empty text block if bare.
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: newId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: toAnthropicUsage(usage, estimateTokens(promptText)),
  };
}

export async function handleAnthropicNonStream(
  cfg: Config,
  parsed: ReturnType<typeof parseAnthropicRequest>,
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
  return buildAnthropicMessage(
    model,
    res.text,
    cfg.reasoning ? res.reasoning : "",
    res.toolCalls,
    res.usage,
    prompt,
  );
}

// --- Streaming (SSE) ---
// Emit the standard Anthropic event sequence:
//   message_start -> content_block_start -> content_block_delta* ->
//   content_block_stop -> message_delta -> message_stop

export interface SSEWriter {
  write: (data: string) => void;
  end: () => void;
}

export async function handleAnthropicStream(
  cfg: Config,
  parsed: ReturnType<typeof parseAnthropicRequest>,
  sse: SSEWriter,
  signal: AbortSignal,
  rid?: string,
): Promise<void> {
  const prompt = buildTranscript(parsed.system, parsed.messages);
  const model = parsed.model || cfg.defaultModel;
  const id = newId("msg");

  const send = (event: string, data: object) => {
    sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const inputTokens = estimateTokens(prompt);
  send("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        service_tier: "standard",
      },
    },
  });

  // Content blocks open lazily. reasoning -> "thinking", message -> "text",
  // tool call -> "tool_use". When the kind switches we close the current block
  // and open a new one, preserving the order the model produced.
  let index = -1;
  let openKind: "thinking" | "text" | "tool_use" | null = null;
  let pinged = false;
  let sawToolUse = false;

  const openBlock = (kind: "thinking" | "text" | "tool_use", call?: ToolCall) => {
    index++;
    openKind = kind;
    let content_block: Record<string, unknown>;
    if (kind === "thinking") content_block = { type: "thinking", thinking: "", signature: "" };
    else if (kind === "tool_use") content_block = { type: "tool_use", id: call!.id, name: call!.name, input: {} };
    else content_block = { type: "text", text: "" };
    send("content_block_start", { type: "content_block_start", index, content_block });
    // Real Anthropic/DeepSeek emit `ping` right after the first block starts.
    if (!pinged) {
      send("ping", { type: "ping" });
      pinged = true;
    }
  };

  const closeBlock = () => {
    if (openKind === null) return;
    // A thinking block must be sealed with a signature_delta before its stop,
    // matching the shape real Anthropic/DeepSeek endpoints emit — otherwise
    // Claude Code won't render it.
    if (openKind === "thinking") {
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: THINKING_SIGNATURE },
      });
    }
    send("content_block_stop", { type: "content_block_stop", index });
    openKind = null;
  };

  const emit = (kind: "thinking" | "text", text: string) => {
    if (!text) return;
    if (openKind !== kind) {
      closeBlock();
      openBlock(kind);
    }
    // traecli delivers reasoning/message as one block, but Claude Code's TUI
    // renders thinking from incremental deltas — a single huge delta can be
    // skipped. Split into smaller chunks so it arrives like a real stream.
    for (const piece of chunkText(text)) {
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta:
          kind === "thinking"
            ? { type: "thinking_delta", thinking: piece }
            : { type: "text_delta", text: piece },
      });
    }
  };

  // A tool call arrives fully-formed (rawchat accumulates the arguments), so we
  // open the tool_use block, stream its JSON args as input_json_delta chunks,
  // and close it.
  const emitToolUse = (call: ToolCall) => {
    sawToolUse = true;
    closeBlock();
    openBlock("tool_use", call);
    const args = call.arguments && call.arguments.trim() ? call.arguments : "{}";
    for (const piece of chunkText(args)) {
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: piece },
      });
    }
  };

  let streamedText = false;
  const onEvent = (ev: TraeEvent) => {
    if (ev.kind === "reasoning" && cfg.reasoning && ev.text) {
      emit("thinking", ev.text);
    } else if (ev.kind === "message" && ev.text) {
      streamedText = true;
      emit("text", ev.text);
    } else if (ev.kind === "tool_call") {
      emitToolUse(ev.call);
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
    // Fallback if nothing streamed as text.
    if (!streamedText && !sawToolUse && res.text) emit("text", res.text);
    // Ensure at least one block exists so the message is well-formed.
    if (openKind === null) openBlock("text");
    closeBlock();
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: sawToolUse ? "tool_use" : "end_turn", stop_sequence: null },
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: res.usage.cached_input_tokens,
        output_tokens: res.usage.output_tokens,
        service_tier: "standard",
      },
    });
    send("message_stop", { type: "message_stop" });
  } catch (err) {
    if (openKind !== "text") {
      closeBlock();
      openBlock("text");
    }
    send("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: `\n[bridge error] ${(err as Error).message}` },
    });
    closeBlock();
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        service_tier: "standard",
      },
    });
    send("message_stop", { type: "message_stop" });
  } finally {
    sse.end();
  }
}
