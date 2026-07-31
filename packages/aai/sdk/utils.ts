// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared utility functions.
 *
 * This module (exposed as the `@alexkroman1/aai/utils` subpath) must stay
 * free of zod and other runtime dependencies: the CLI imports it on every
 * invocation (including `aai --help`), where pulling zod in would be a
 * measurable startup cost.
 */

import { MAX_TOOL_RESULT_CHARS } from "./constants.ts";

export { RESERVED_SLUGS, VALID_SLUG_RE } from "./slug.ts";

/** Extract an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}

/** Extract a detailed error string (message + stack) for diagnostic logging. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

/**
 * Parse JSON, returning `undefined` on malformed input. JSON cannot encode
 * `undefined`, so the sentinel is unambiguous.
 */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON — fall through to the implicit undefined return.
  }
}

/** Return a JSON error string for the LLM: `'{"error":"<message>"}'`. */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * Cap a tool result to the client wire limit. The wire schema rejects
 * over-long `tool_call_done` results (silently dropping the whole frame), so
 * every emitter must cap through here; the provider still gets the full value.
 */
export function capToolResult(result: string): string {
  return result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
}

/**
 * Coerce a tool call's input to the wire schema's args record. The AI SDK
 * surfaces an unparsable/invalid tool call as a `tool-call` part whose
 * `input` is the raw argument string (or any JSON value), not a parsed
 * object — shipping that verbatim fails the `tool_call` / sync `toolCalls`
 * schemas, which require a record. Anything that isn't a plain object
 * becomes `{}` so one bad call degrades to empty args instead of
 * invalidating the whole frame or response.
 */
export function toArgsRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Text-based client asset extensions safe to carry as a UTF-8 string. */
const TEXT_ASSET_EXTENSIONS = new Set([
  "html",
  "htm",
  "js",
  "mjs",
  "cjs",
  "css",
  "json",
  "map",
  "svg",
  "txt",
  "xml",
  "webmanifest",
]);

/**
 * Whether a client asset path holds UTF-8 text (vs. binary like png/woff2).
 * Binary assets must be base64-encoded to survive a string transport, so the
 * bundler and the server serve path both key off this shared heuristic.
 */
export function isTextAssetPath(assetPath: string): boolean {
  const dot = assetPath.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_ASSET_EXTENSIONS.has(assetPath.slice(dot + 1).toLowerCase());
}
