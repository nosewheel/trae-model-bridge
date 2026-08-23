// Direct client for traecli's underlying model endpoint: llm_raw_chat.
//
// Instead of spawning `traecli exec` (a full agent that executes tools in a
// sandbox), we call the same backend directly and act as a pure model API: the
// caller's tools are passed through, the model may reply or request a tool call,
// and the caller (e.g. Claude Code) executes the tool and feeds the result back.
// The bridge itself never runs a tool. Credentials (JWT + base URL) are read
// from traecli's auth.json.
//
// Endpoint:  POST <api_base_url>/api/ide/v2/llm_raw_chat
// Auth:      authorization: Cloud-IDE-JWT <access_token>
// Body:      { config_name, model_name, user_input:"",
//              messages:[{role,content:[{type:"text",text}], tool_calls?, tool_call_id?}],
//              tools:[{type:"function",function:{name,description,parameters}}],
//              session_id, conversation_id, access_type:4 }
// Response:  SSE. data: {"response":"...","reasoning_content":"...","tool_calls":[...]}
//            response carries the answer, reasoning_content the thinking, and
//            tool_calls (function_call.name + arguments string) the tool request.
//            A trailing frame carries token usage.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { getLogger } from "./logger.ts";
import type { ChatMessage, ToolCall, ToolDef } from "./transcript.ts";
import type { RunResult, TraeEvent, TraeUsage } from "./traecli.ts";

const APP_ID = "7b3f9dc2-8a4e-5c6d-2f1b-9e4a3c5b7df0";
const VERSION = "0.201.4-tob";

interface TraeAuth {
  access_token: string;
  base_url: string;
}

/** Read traecli's stored JWT and API base URL. Throws a clear error if missing/expired. */
export function loadTraeAuth(authPath: string): TraeAuth {
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    throw new Error(`cannot read traecli auth at ${authPath}. Run \`traecli login\` first.`);
  }
  const data = JSON.parse(raw) as { trae?: Record<string, unknown> };
  const t = data.trae;
  if (!t || typeof t.access_token !== "string") {
    throw new Error("traecli auth.json has no trae.access_token. Run `traecli login`.");
  }
  const endpoints = (t.endpoints ?? {}) as Record<string, string>;
  const base = endpoints.api_base_url;
  if (!base) throw new Error("traecli auth.json has no trae.endpoints.api_base_url.");
  if (typeof t.expires_at === "string" && Date.parse(t.expires_at) < Date.now()) {
    throw new Error(`traecli token expired at ${t.expires_at}. Run \`traecli login\` to refresh.`);
  }
  return { access_token: t.access_token, base_url: base.replace(/\/$/, "") };
}

interface ModelIds {
  configName: string;
  modelName: string;
}

/** Resolve a request model name to llm_raw_chat's config_name + model_name (variant key). */
export function resolveModelIds(modelsCachePath: string, requested: string): ModelIds {
  let models: Array<Record<string, unknown>> = [];
  try {
    const data = JSON.parse(readFileSync(modelsCachePath, "utf8")) as {
      models?: Array<Record<string, unknown>>;
    };
    models = data.models ?? [];
  } catch {
    // fall through to heuristic
  }
  const wanted = requested.toLowerCase();
  for (const m of models) {
    const slug = String(m.slug ?? "");
    const configName = String(m.config_name ?? "");
    if (slug.toLowerCase() === wanted || configName.toLowerCase() === wanted) {
      const bm = (m.business_metadata ?? {}) as Record<string, unknown>;
      const variants = (bm.variants ?? {}) as Record<string, unknown>;
      const key = (variants.standard_key ?? variants.max_key) as string | undefined;
      // Upstream keys chat on config_name, which is a distinct field from slug
      // (e.g. slug "GLM-5.3" vs config_name "glm-5.3"). Prefer config_name.
      const cfg = configName || slug || requested;
      return { configName: cfg, modelName: key || `${cfg}__v2` };
    }
  }
  // Not found in cache: assume the __v2 variant convention.
  return { configName: requested, modelName: `${requested}__v2` };
}

/** Upstream message content is always an array of typed blocks. */
type RawBlock = { type: "text"; text: string };
interface RawMessage {
  role: string;
  content: RawBlock[];
  /** Present on assistant turns that called tools (upstream uses function_call). */
  tool_calls?: Array<{
    index: number;
    id: string;
    type: "function";
    function_call: { name: string; arguments: string };
  }>;
  /** Present on tool-result turns. */
  tool_call_id?: string;
}

/** Convert flat ChatMessages (incl. tool calls/results) to llm_raw_chat's shape. */
function toRawMessages(system: string | null, messages: ChatMessage[]): RawMessage[] {
  const out: RawMessage[] = [];
  if (system && system.trim()) {
    out.push({ role: "system", content: [{ type: "text", text: system }] });
  }
  for (const m of messages) {
    // Tool result turn: role "tool" carries the output of a prior tool_call.
    // Verified upstream shape: {role:"tool", tool_call_id, content:[{type:"text",text}]}.
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: [{ type: "text", text: m.content ?? "" }],
      });
      continue;
    }
    // Assistant turn that requested tools. Upstream expects function_call (not
    // the OpenAI-standard `function` key) or it won't recognize the prior call.
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
      out.push({
        role: "assistant",
        content: [{ type: "text", text: m.content ?? "" }],
        tool_calls: m.toolCalls.map((c, i) => ({
          index: i,
          id: c.id,
          type: "function",
          function_call: { name: c.name, arguments: c.arguments || "{}" },
        })),
      });
      continue;
    }
    if (!m.content.trim()) continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    out.push({ role, content: [{ type: "text", text: m.content }] });
  }
  if (out.length === 0) out.push({ role: "user", content: [{ type: "text", text: "" }] });
  return out;
}

/** Convert normalized tool defs to the upstream function-tool shape. */
function toRawTools(tools: ToolDef[] | undefined) {
  if (!tools || !tools.length) return [];
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      // Upstream requires `parameters` as a JSON *string*, not an object —
      // sending an object yields HTTP 500. (Verified against llm_raw_chat.)
      parameters: stringifySchema(t.parameters),
    },
  }));
}

/** Serialize a JSON-schema value to the string form llm_raw_chat expects. */
function stringifySchema(schema: unknown): string {
  if (typeof schema === "string") return schema;
  if (schema == null) return JSON.stringify({ type: "object", properties: {} });
  try {
    return JSON.stringify(schema);
  } catch {
    return JSON.stringify({ type: "object", properties: {} });
  }
}

export interface RawChatOptions {
  system: string | null;
  messages: ChatMessage[];
  model?: string;
  /** Tools advertised by the caller. Passed through to the model verbatim. */
  tools?: ToolDef[];
  rid?: string;
  onEvent?: (ev: TraeEvent) => void;
  signal?: AbortSignal;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/**
 * Call llm_raw_chat directly and stream the result. Tools advertised by the
 * caller are passed through: the model may answer or ask for a tool call, which
 * the caller (e.g. Claude Code) executes and feeds back on the next request.
 * The bridge never executes tools itself. Returns the same RunResult shape as
 * runTraecli so adapters are unchanged.
 */
export async function runRawChat(cfg: Config, opts: RawChatOptions): Promise<RunResult> {
  const started = Date.now();
  const log = getLogger();
  const tag = opts.rid ? `${opts.rid} ` : "";

  const auth = loadTraeAuth(cfg.authPath);
  const requested = opts.model && opts.model.trim() ? opts.model : cfg.defaultModel;
  const { configName, modelName } = resolveModelIds(cfg.modelsCachePath, requested);
  const url = `${auth.base_url}/api/ide/v2/llm_raw_chat`;

  const rawTools = toRawTools(opts.tools);
  const body = {
    config_name: configName,
    model_name: modelName,
    user_input: "",
    messages: toRawMessages(opts.system, opts.messages),
    tools: rawTools,
    session_id: randomUUID(),
    conversation_id: randomUUID(),
    access_type: 4,
  };

  log.debug(`${tag}rawchat POST ${url} model=${configName}/${modelName} msgs=${body.messages.length} tools=${rawTools.length}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Cloud-IDE-JWT ${auth.access_token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      version: VERSION,
      "x-app-id": APP_ID,
      "x-ide-function": "chat",
      "x-ide-version-code": "20260206",
      "x-ide-version": "99.99.99",
      originator: "codex_exec",
      "user-agent": `codex_exec/${VERSION}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`llm_raw_chat HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const messages: string[] = [];
  const reasonings: string[] = [];
  // Tool calls arrive as one or more SSE frames; upstream may stream argument
  // fragments, so accumulate by index into id/name/arguments.
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  const toolEmitted = new Set<number>();
  let usage: TraeUsage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };

  const dec = new TextDecoder();
  let buf = "";
  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (!payload || payload[0] !== "{") return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(payload);
    } catch {
      return;
    }
    log.debug(`${tag}rawchat raw:`, log.preview(payload));
    if (typeof o.reasoning_content === "string" && o.reasoning_content) {
      reasonings.push(o.reasoning_content);
      opts.onEvent?.({ kind: "reasoning", text: o.reasoning_content });
    }
    if (typeof o.response === "string" && o.response) {
      messages.push(o.response);
      opts.onEvent?.({ kind: "message", text: o.response });
    }
    if (Array.isArray(o.tool_calls)) {
      for (const raw of o.tool_calls as Array<Record<string, unknown>>) {
        const index = num(raw.index);
        const fn = (raw.function_call ?? raw.function ?? {}) as Record<string, unknown>;
        const cur = toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof raw.id === "string" && raw.id) cur.id = raw.id;
        if (typeof fn.name === "string" && fn.name) cur.name = fn.name;
        if (typeof fn.arguments === "string") cur.arguments += fn.arguments;
        toolAcc.set(index, cur);
      }
    }
    // token usage frame
    if ("prompt_tokens" in o || "completion_tokens" in o) {
      usage = {
        input_tokens: num(o.prompt_tokens),
        cached_input_tokens: num(o.cache_read_input_tokens),
        output_tokens: num(o.completion_tokens),
        reasoning_output_tokens: num(o.reasoning_tokens),
      };
    }
  };

  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) handleLine(buf);

  // Finalize tool calls (ensure each has an id) and surface them to the caller.
  const toolCalls: ToolCall[] = [];
  for (const [index, c] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    const call: ToolCall = {
      id: c.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      name: c.name,
      arguments: c.arguments || "{}",
    };
    toolCalls.push(call);
    if (!toolEmitted.has(index)) {
      opts.onEvent?.({ kind: "tool_call", call });
      toolEmitted.add(index);
    }
  }

  const result: RunResult = {
    threadId: null,
    text: messages.join("").trim(),
    reasoning: reasonings.join("").trim(),
    toolCalls,
    usage,
    durationMs: Date.now() - started,
  };
  log.debug(
    `${tag}rawchat result: dur=${result.durationMs}ms usage=${JSON.stringify(result.usage)} reasoning_chars=${result.reasoning.length} tool_calls=${toolCalls.length} text=`,
    log.preview(result.text),
  );
  return result;
}

/** Default auth + models-cache paths under ~/.trae. */
export function defaultAuthPath(): string {
  return join(homedir(), ".trae", "cli", "auth.json");
}
export function defaultModelsCachePath(): string {
  return join(homedir(), ".trae", "model-provider", "trae", "models_cache.json");
}
