// LEGACY (agent mode): spawns `traecli exec --json`, feeds a prompt on stdin,
// and parses the JSONL event stream emitted on stdout.
//
// The bridge no longer calls this by default — it uses src/rawchat.ts, which
// hits the underlying llm_raw_chat endpoint with tools:[] for a pure model call
// (no agent tool loop). This module is kept for its shared types (RunResult,
// TraeEvent, TraeUsage) and as a fallback agent-mode implementation.
//
// Observed event contract for `traecli exec --json` (v0.201.4):
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
//                                     "output_tokens":N,"reasoning_output_tokens":N}}
//   {"type":"turn.failed","error":{...}}   // on failure
//
// item.type is one of: agent_message, reasoning_text, command_execution,
// mcp_tool_call, web_search_call, error, ...
// Only agent_message carries the user-facing answer. Tool items are surfaced as
// intermediate events but not returned as the answer.
//
// Note: `traecli exec --json` emits block-level events only (no token-level
// deltas), so streaming to clients is necessarily coarse-grained.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { ToolCall } from "./transcript.ts";
import { getLogger } from "./logger.ts";

export interface TraeUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface RunResult {
  threadId: string | null;
  /** Concatenation of all agent_message items (the user-facing answer). */
  text: string;
  /** Concatenation of all reasoning items (the model's thinking, if surfaced). */
  reasoning: string;
  /** Tool calls the model requested this turn (empty when it just answered). */
  toolCalls: ToolCall[];
  usage: TraeUsage;
  /** Wall-clock duration of the traecli process. */
  durationMs: number;
}

/** A parsed event we surface to callers (used for streaming progress). */
export type TraeEvent =
  | { kind: "thread.started"; threadId: string }
  | { kind: "turn.started" }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; toolType: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "message"; text: string }
  | { kind: "turn.completed"; usage: TraeUsage }
  | { kind: "turn.failed"; message: string };

export interface RunOptions {
  prompt: string;
  model?: string;
  /** Working directory for this turn. Overrides cfg.cwd when set. */
  cwd?: string;
  /** Request id used to correlate log lines with the HTTP request. */
  rid?: string;
  /** Called for every parsed event, in order. Useful for streaming. */
  onEvent?: (ev: TraeEvent) => void;
  /** AbortSignal to cancel the underlying process (e.g. client disconnect). */
  signal?: AbortSignal;
}

const EMPTY_USAGE: TraeUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

function normalizeUsage(raw: unknown): TraeUsage {
  if (!raw || typeof raw !== "object") return { ...EMPTY_USAGE };
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cached_input_tokens),
    output_tokens: num(u.output_tokens),
    reasoning_output_tokens: num(u.reasoning_output_tokens),
  };
}

/**
 * Turn one parsed JSONL object into a TraeEvent (or null if uninteresting).
 * Kept pure so it is easy to unit test.
 */
export function classifyEvent(obj: Record<string, unknown>): TraeEvent | null {
  switch (obj.type) {
    case "thread.started":
      return { kind: "thread.started", threadId: String(obj.thread_id ?? "") };
    case "turn.started":
      return { kind: "turn.started" };
    case "turn.completed":
      return { kind: "turn.completed", usage: normalizeUsage(obj.usage) };
    case "turn.failed": {
      const err = obj.error as Record<string, unknown> | undefined;
      const message =
        (err && typeof err.message === "string" && err.message) ||
        JSON.stringify(obj.error ?? "unknown error");
      return { kind: "turn.failed", message };
    }
    case "item.completed": {
      const item = obj.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const text = typeof item.text === "string" ? item.text : "";
      switch (item.type) {
        case "agent_message":
          return { kind: "message", text };
        case "reasoning":
        case "reasoning_text":
          return { kind: "reasoning", text };
        case "error":
          return { kind: "turn.failed", message: text || "agent error" };
        default:
          // command_execution, mcp_tool_call, web_search_call, ...
          return { kind: "tool", toolType: String(item.type ?? "tool") };
      }
    }
    default:
      return null;
  }
}

/**
 * Resolve the working directory for a turn: expand a leading `~`, then verify
 * it's an existing directory. Falls back to cfg.cwd if the requested path is
 * missing or not a directory (so a stale/foreign cwd never breaks the request).
 */
function resolveCwd(cfg: Config, requested: string | undefined): string {
  if (!requested) return cfg.cwd;
  let p = requested.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (!p.startsWith("/")) return cfg.cwd;
  try {
    if (statSync(p).isDirectory()) return p;
  } catch {
    // not accessible
  }
  return cfg.cwd;
}

/** Build the argv for `traecli exec --json`. */
function buildArgs(cfg: Config, model: string, cwd: string, lastMsgFile: string): string[] {
  const args = ["exec", "--json", "--color", "never"];
  if (cfg.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (cfg.ephemeral) args.push("--ephemeral");
  args.push("-s", cfg.sandbox);
  args.push("-m", model);
  args.push("-C", cwd);
  args.push("-o", lastMsgFile);
  if (cfg.reasoning) {
    // Ask traecli to surface reasoning items in the JSONL stream. Models that
    // support summaries will emit `reasoning` items; others simply won't.
    args.push("-c", "hide_agent_reasoning=false");
    args.push("-c", 'model_reasoning_summary="auto"');
  }
  return args;
}

/**
 * Run one traecli exec turn. Feeds `prompt` on stdin (avoids argv limits) and
 * resolves once the process exits.
 */
export async function runTraecli(
  cfg: Config,
  opts: RunOptions,
): Promise<RunResult> {
  const model = opts.model && opts.model.trim() ? opts.model : cfg.defaultModel;
  const started = Date.now();
  const log = getLogger();
  const cwd = resolveCwd(cfg, opts.cwd);
  const tag = opts.rid ? `${opts.rid} ` : "";

  const tmp = await mkdtemp(join(tmpdir(), "trae-model-bridge-"));
  const lastMsgFile = join(tmp, "last-message.txt");
  const args = buildArgs(cfg, model, cwd, lastMsgFile);

  log.debug(`${tag}traecli cwd: ${cwd}${opts.cwd && opts.cwd !== cwd ? ` (requested: ${opts.cwd})` : ""}`);
  log.debug(`${tag}traecli spawn: ${cfg.bin} ${args.join(" ")}`);
  log.debug(`${tag}traecli prompt:`, log.preview(opts.prompt));

  const messages: string[] = [];
  const reasonings: string[] = [];
  let threadId: string | null = null;
  let usage: TraeUsage = { ...EMPTY_USAGE };
  let failure: string | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cfg.bin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`traecli timed out after ${cfg.timeoutMs}ms`));
      }, cfg.timeoutMs);

      const onAbort = () => {
        child.kill("SIGKILL");
        reject(new Error("request aborted by client"));
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Parse stdout as newline-delimited JSON.
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          // Raw JSONL line as traecli emitted it, before parsing.
          log.debug(`${tag}traecli raw:`, log.preview(line));
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue; // ignore any non-JSON noise
          }
          const ev = classifyEvent(obj);
          if (!ev) continue;
          log.debug(
            `${tag}traecli event: ${ev.kind}`,
            ev.kind === "message" || ev.kind === "reasoning" ? log.preview(ev.text) : "",
          );
          if (ev.kind === "thread.started") threadId = ev.threadId;
          else if (ev.kind === "message") messages.push(ev.text);
          else if (ev.kind === "reasoning") reasonings.push(ev.text);
          else if (ev.kind === "turn.completed") usage = ev.usage;
          else if (ev.kind === "turn.failed") failure = ev.message;
          opts.onEvent?.(ev);
        }
      });

      // traecli prints verbose tracing on stderr; capture only for diagnostics.
      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(
          new Error(
            `failed to spawn "${cfg.bin}": ${err.message}. Is traecli installed and on PATH?`,
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        log.debug(`${tag}traecli exited: code=${code}`);
        if (code !== 0 && messages.length === 0 && !failure) {
          failure = `traecli exited with code ${code}. stderr tail:\n${stderrTail}`;
        }
        if (code !== 0 && stderrTail) log.debug(`${tag}traecli stderr tail:`, log.preview(stderrTail));
        resolve();
      });

      // Feed the prompt and close stdin.
      child.stdin.write(opts.prompt);
      child.stdin.end();
    });

    if (failure && messages.length === 0) {
      throw new Error(failure);
    }

    let text = messages.join("\n").trim();
    // Fallback: if no agent_message was captured, use the -o last-message file.
    if (!text) {
      text = (await readFile(lastMsgFile, "utf8").catch(() => "")).trim();
    }

    const result: RunResult = {
      threadId,
      text,
      reasoning: reasonings.join("\n\n").trim(),
      toolCalls: [],
      usage,
      durationMs: Date.now() - started,
    };
    log.debug(
      `${tag}traecli result: thread=${result.threadId} dur=${result.durationMs}ms usage=${JSON.stringify(result.usage)} reasoning_chars=${result.reasoning.length} text=`,
      log.preview(result.text),
    );
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
