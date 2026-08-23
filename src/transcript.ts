// Shared helpers to flatten chat-style message arrays into a single prompt
// string for traecli, and to generate ids/token estimates.

import { randomUUID } from "node:crypto";

/**
 * A tool the caller advertised to the model. Normalized to the upstream
 * function shape ({name, description, parameters}) that llm_raw_chat expects.
 */
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** A tool invocation the model asked for (arguments is a raw JSON string). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  /** Set on assistant turns that requested tools (protocol-agnostic). */
  toolCalls?: ToolCall[];
  /** Set on tool-result turns: the id of the call this message answers. */
  toolCallId?: string;
}

/**
 * Render a system prompt + conversation transcript into one text block that we
 * feed to `traecli exec` on stdin. traecli treats the whole thing as the user
 * turn; labelling each message by role keeps multi-turn context legible to the
 * underlying model.
 */
export function buildTranscript(
  system: string | null,
  messages: ChatMessage[],
): string {
  const parts: string[] = [];
  if (system && system.trim()) {
    parts.push(`[system]\n${system.trim()}`);
  }
  for (const m of messages) {
    const content = m.content.trim();
    if (!content) continue;
    parts.push(`[${m.role}]\n${content}`);
  }
  // Nudge the model to answer directly rather than ask a follow-up.
  return parts.join("\n\n");
}

/**
 * Best-effort extraction of the caller's working directory from its system
 * prompt. Coding agents inject their cwd into the system prompt (Claude Code:
 * "Working directory: /path"; Codex-style: "<cwd>/path</cwd>"). We honor it so
 * traecli runs in the directory the caller is actually working in, not wherever
 * the bridge process happens to live. Returns null if nothing plausible found.
 */
export function extractCwd(text: string | null): string | null {
  if (!text) return null;
  const patterns: RegExp[] = [
    /<cwd>\s*([^<\n]+?)\s*<\/cwd>/gi,
    /(?:current|primary)?[ \t]*working directory(?: is)?:[ \t]*([^\n]+)/gi,
    /(?:^|\n)[ \t>*-]*cwd:[ \t]*([^\n]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const p = m[1].trim().replace(/["'`.,;]+$/, "").trim();
      if (p.startsWith("~") || p.startsWith("/")) return p;
    }
  }
  return null;
}

/** Rough token estimate (~4 chars/token) for fields we cannot get exactly. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
