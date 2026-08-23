// Central configuration, all overridable via environment variables.
// Some values can also be set with CLI flags (see parseCliArgs / loadConfig).

export type LogMode = "off" | "info" | "debug";

export interface Config {
  host: string;
  port: number;
  /** Path to the traecli/trae-cli binary. */
  bin: string;
  /** Default model passed to `traecli exec -m` when a request does not force one. */
  defaultModel: string;
  /** Sandbox mode for the underlying agent. read-only is the safe default. */
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** Working directory the agent runs in. */
  cwd: string;
  /** Hard timeout (ms) for a single traecli invocation. */
  timeoutMs: number;
  /** Max concurrent traecli processes. traecli is heavy, so keep this small. */
  maxConcurrency: number;
  /** Optional bearer token clients must send (Authorization: Bearer <token>). */
  apiKey: string | null;
  /** Logging verbosity: off | info | debug. */
  logMode: LogMode;
  /** Max chars of a body/SSE payload printed in debug mode (<=0 = unlimited). */
  logMaxChars: number;
  /** Pass --ephemeral so sessions are not persisted to disk. */
  ephemeral: boolean;
  /** Pass --skip-git-repo-check so the agent runs anywhere. */
  skipGitRepoCheck: boolean;
  /** Surface traecli reasoning to clients (Anthropic thinking blocks, etc.). */
  reasoning: boolean;
  /** Path to traecli's auth.json (JWT + endpoints) for direct llm_raw_chat calls. */
  authPath: string;
  /** Path to traecli's models cache (for model_name/config_name resolution). */
  modelsCachePath: string;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function normalizeLogMode(v: string | undefined): LogMode | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (s === "off" || s === "info" || s === "debug") return s;
  if (s === "verbose") return "debug"; // friendly alias
  return undefined;
}

/** CLI overrides parsed from argv. All fields optional. */
export interface CliArgs {
  logMode?: LogMode;
  port?: number;
  host?: string;
}

/**
 * Parse the subset of flags we accept on the command line, e.g.
 *   node src/server.ts --log-mode debug --port 9000
 * Supports `--flag value` and `--flag=value`. Unknown flags are ignored.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = () => inlineVal ?? argv[++i];
    switch (key) {
      case "log-mode":
      case "log": {
        const m = normalizeLogMode(next());
        if (m) out.logMode = m;
        break;
      }
      case "debug":
        // bare `--debug` shorthand
        out.logMode = "debug";
        break;
      case "port": {
        const n = Number.parseInt(next() ?? "", 10);
        if (Number.isFinite(n)) out.port = n;
        break;
      }
      case "host":
        out.host = next();
        break;
      default:
        break;
    }
  }
  return out;
}

export function loadConfig(cli: CliArgs = {}): Config {
  const sandbox = envStr("BRIDGE_SANDBOX", "read-only");
  if (
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  ) {
    throw new Error(
      `Invalid BRIDGE_SANDBOX="${sandbox}". Use read-only | workspace-write | danger-full-access.`,
    );
  }

  // Precedence for log mode: CLI flag > BRIDGE_LOG_MODE > legacy BRIDGE_VERBOSE > default.
  const logMode: LogMode =
    cli.logMode ??
    normalizeLogMode(process.env.BRIDGE_LOG_MODE) ??
    (envBool("BRIDGE_VERBOSE", true) ? "info" : "off");

  return {
    host: cli.host ?? envStr("BRIDGE_HOST", "127.0.0.1"),
    port: cli.port ?? envInt("BRIDGE_PORT", 8787),
    bin: envStr("BRIDGE_TRAECLI_BIN", "traecli"),
    defaultModel: envStr("BRIDGE_DEFAULT_MODEL", "openrouter-3o"),
    sandbox,
    cwd: envStr("BRIDGE_CWD", process.cwd()),
    timeoutMs: envInt("BRIDGE_TIMEOUT_MS", 600_000),
    maxConcurrency: envInt("BRIDGE_MAX_CONCURRENCY", 2),
    apiKey: process.env.BRIDGE_API_KEY ? process.env.BRIDGE_API_KEY : null,
    logMode,
    logMaxChars: envInt("BRIDGE_LOG_MAX_CHARS", 100_000),
    ephemeral: envBool("BRIDGE_EPHEMERAL", true),
    skipGitRepoCheck: envBool("BRIDGE_SKIP_GIT_CHECK", true),
    reasoning: envBool("BRIDGE_REASONING", true),
    authPath: envStr("BRIDGE_AUTH_PATH", `${process.env.HOME}/.trae/cli/auth.json`),
    modelsCachePath: envStr(
      "BRIDGE_MODELS_CACHE_PATH",
      `${process.env.HOME}/.trae/model-provider/trae/models_cache.json`,
    ),
  };
}
