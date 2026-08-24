#!/usr/bin/env node
// trae-model-bridge HTTP server.
//
// Exposes the model behind a local `traecli` (TraeCode CLI) install as both
// OpenAI- and Anthropic-compatible HTTP endpoints:
//   GET  /health
//   GET  /v1/models
//   POST /v1/chat/completions   (OpenAI, stream + non-stream)   -> Codex, etc.
//   POST /v1/messages           (Anthropic, stream + non-stream) -> Claude Code
//
// Every request is answered by spawning `traecli exec --json`. See src/traecli.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { loadConfig, parseCliArgs } from "./config.ts";
import { Logger, shortId, setActiveLogger } from "./logger.ts";
import { listModels } from "./models.ts";
import { Semaphore } from "./semaphore.ts";
import { nowUnix } from "./transcript.ts";
import {
  handleOpenAINonStream,
  handleOpenAIStream,
  parseOpenAIRequest,
} from "./openai.ts";
import {
  handleAnthropicNonStream,
  handleAnthropicStream,
  parseAnthropicRequest,
} from "./anthropic.ts";
import {
  handleResponsesNonStream,
  handleResponsesStream,
  parseResponsesRequest,
} from "./responses.ts";

// Load .env from the current working directory before reading config, so
// BRIDGE_* vars can live in a file. Zero-dependency: Node's built-in loader.
// Real env vars still win (loadEnvFile does not overwrite existing ones).
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // ignore a malformed/unreadable .env; fall back to process env + defaults
  }
}

const cfg = loadConfig(parseCliArgs(process.argv.slice(2)));
const sem = new Semaphore(cfg.maxConcurrency);
const logger = new Logger(cfg.logMode, cfg.logMaxChars);
setActiveLogger(logger);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 32 * 1024 * 1024; // 32 MB guard
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: object, rid?: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
  if (rid) logger.debug(`${rid} <- ${status} body:`, logger.preview(payload));
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
  rid?: string,
): void {
  sendJson(res, status, { error: { message, type } }, rid);
}

function openSSE(
  res: ServerResponse,
  rid?: string,
): { write: (d: string) => void; end: () => void } {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (rid) logger.debug(`${rid} <- 200 (SSE stream opened)`);
  return {
    write: (d: string) => {
      if (rid) logger.debug(`${rid} <- SSE:`, logger.preview(d.trimEnd()));
      res.write(d);
    },
    end: () => res.end(),
  };
}

/** Bearer-token check (only enforced when BRIDGE_API_KEY is set). */
function authorized(req: IncomingMessage): boolean {
  if (!cfg.apiKey) return true;
  const h = req.headers["authorization"];
  const x = req.headers["x-api-key"]; // Anthropic-style header
  if (typeof h === "string" && h === `Bearer ${cfg.apiKey}`) return true;
  if (typeof x === "string" && x === cfg.apiKey) return true;
  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rid = shortId();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  logger.info(`${rid} -> ${method} ${path}`);
  logger.debug(`${rid} request headers:`, logger.redactHeaders(req.headers));

  if (method === "GET" && path === "/health") {
    return sendJson(res, 200, { status: "ok", bin: cfg.bin, model: cfg.defaultModel }, rid);
  }

  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    const models = await listModels(cfg.defaultModel);
    return sendJson(res, 200, {
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        created: nowUnix(),
        owned_by: "traecli",
      })),
    }, rid);
  }

  const isOpenAIChat = method === "POST" && path === "/v1/chat/completions";
  const isResponses = method === "POST" && (path === "/v1/responses" || path === "/v1/responses/");
  const isAnthropic = method === "POST" && (path === "/v1/messages" || path === "/v1/messages/");

  if (!isOpenAIChat && !isResponses && !isAnthropic) {
    return sendError(res, 404, `no route for ${method} ${path}`, "not_found", rid);
  }

  if (!authorized(req)) {
    return sendError(res, 401, "missing or invalid credentials", "authentication_error", rid);
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    logger.debug(`${rid} request body:`, logger.preview(raw || "(empty)"));
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return sendError(res, 400, `invalid JSON body: ${(err as Error).message}`, "invalid_request_error", rid);
  }

  // AbortSignal wired to client disconnect so we can kill traecli early.
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  // Parse/validate first so malformed requests are 400s, not 500s.
  let parsedOpenAI: ReturnType<typeof parseOpenAIRequest> | null = null;
  let parsedResponses: ReturnType<typeof parseResponsesRequest> | null = null;
  let parsedAnthropic: ReturnType<typeof parseAnthropicRequest> | null = null;
  try {
    if (isOpenAIChat) parsedOpenAI = parseOpenAIRequest(body);
    else if (isResponses) parsedResponses = parseResponsesRequest(body);
    else parsedAnthropic = parseAnthropicRequest(body);
  } catch (err) {
    return sendError(res, 400, (err as Error).message, "invalid_request_error", rid);
  }

  const release = await sem.acquire();
  const startedAt = Date.now();
  try {
    if (parsedOpenAI) {
      const parsed = parsedOpenAI;
      logger.info(`${rid} openai`, { model: parsed.model || cfg.defaultModel, stream: parsed.stream, msgs: parsed.messages.length });
      if (parsed.stream) {
        await handleOpenAIStream(cfg, parsed, openSSE(res, rid), ac.signal, rid);
      } else {
        const out = await handleOpenAINonStream(cfg, parsed, rid);
        sendJson(res, 200, out, rid);
      }
    } else if (parsedResponses) {
      const parsed = parsedResponses;
      logger.info(`${rid} responses`, { model: parsed.model || cfg.defaultModel, stream: parsed.stream, msgs: parsed.messages.length });
      if (parsed.stream) {
        await handleResponsesStream(cfg, parsed, openSSE(res, rid), ac.signal, rid);
      } else {
        const out = await handleResponsesNonStream(cfg, parsed, rid);
        sendJson(res, 200, out, rid);
      }
    } else {
      const parsed = parsedAnthropic!;
      logger.info(`${rid} anthropic`, { model: parsed.model || cfg.defaultModel, stream: parsed.stream, msgs: parsed.messages.length });
      if (parsed.stream) {
        await handleAnthropicStream(cfg, parsed, openSSE(res, rid), ac.signal, rid);
      } else {
        const out = await handleAnthropicNonStream(cfg, parsed, rid);
        sendJson(res, 200, out, rid);
      }
    }
    logger.info(`${rid} done in ${Date.now() - startedAt} ms`);
  } catch (err) {
    const message = (err as Error).message;
    logger.info(`${rid} error:`, message);
    if (res.headersSent) {
      res.end();
    } else {
      sendError(res, 500, message, "api_error", rid);
    }
  } finally {
    release();
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    logger.info("unhandled:", err);
    if (!res.headersSent) sendError(res, 500, String(err), "api_error");
    else res.end();
  });
});

server.listen(cfg.port, cfg.host, () => {
  logger.info(`listening on http://${cfg.host}:${cfg.port}`);
  logger.info(`traecli bin: ${cfg.bin} | default model: ${cfg.defaultModel} | sandbox: ${cfg.sandbox}`);
  logger.info(`concurrency: ${cfg.maxConcurrency} | auth: ${cfg.apiKey ? "required" : "open"} | log-mode: ${cfg.logMode}`);
  logger.info("routes: GET /health  GET /v1/models  POST /v1/chat/completions  POST /v1/responses  POST /v1/messages");
});
