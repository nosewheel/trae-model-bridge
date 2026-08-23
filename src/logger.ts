// Logging helpers. Verbosity is controlled by LogMode:
//   off   - nothing
//   info  - one-line request/response summaries (method, path, status, timing)
//   debug - info + full request (headers/body) and full response (body/SSE)

import type { LogMode } from "./config.ts";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "proxy-authorization",
]);

export class Logger {
  private readonly mode: LogMode;
  private readonly maxChars: number;

  constructor(mode: LogMode, maxChars: number = 100_000) {
    this.mode = mode;
    this.maxChars = maxChars;
  }

  get isDebug(): boolean {
    return this.mode === "debug";
  }

  info(...args: unknown[]): void {
    if (this.mode !== "off") console.error("[bridge]", ...args);
  }

  debug(...args: unknown[]): void {
    if (this.mode === "debug") console.error("[bridge:debug]", ...args);
  }

  /** Truncate long payloads so debug logs stay readable. maxChars<=0 = unlimited. */
  preview(text: string): string {
    if (this.maxChars <= 0 || text.length <= this.maxChars) return text;
    return `${text.slice(0, this.maxChars)}… <truncated ${text.length - this.maxChars} chars>`;
  }

  /** Copy headers, masking anything that may carry credentials. */
  redactHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v;
    }
    return out;
  }
}

/** Short, non-cryptographic id used to correlate a request's log lines. */
export function shortId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

// Shared instance so modules that aren't handed a Logger (e.g. the traecli
// runner) can still emit debug lines. Defaults to "off" until the server sets it.
let active = new Logger("off");

export function setActiveLogger(logger: Logger): void {
  active = logger;
}

export function getLogger(): Logger {
  return active;
}
