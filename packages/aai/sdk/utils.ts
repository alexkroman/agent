// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared utility functions (the `@alexkroman1/aai/utils` subpath).
 *
 * For user tool code: `errorMessage`, `errorDetail`, `safeJsonParse`, and
 * `toolError`. The remaining exports are framework plumbing shared with the
 * sibling packages. The module stays free of zod and other runtime
 * dependencies so the CLI can import it on every invocation without a
 * startup cost.
 *
 * @module utils
 */

import { MAX_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_MARKER } from "./constants.ts";

export { MAX_SLUG_LENGTH, PREVIEW_SLUG_SUFFIX, RESERVED_SLUGS, VALID_SLUG_RE } from "./slug.ts";

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

/**
 * Format an error for a tool result: returns the JSON string
 * `'{"error":"<message>"}'`. Return this from a tool's `execute` (instead of
 * throwing) when the failure is something the LLM should see and recover
 * from — e.g. "no results found, try a broader query".
 */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * Cap a tool result to the client wire limit. The wire schema rejects
 * over-long `tool_call_done` results (silently dropping the whole frame), so
 * every emitter must cap through here; the provider still gets the full value.
 *
 * @internal
 */
export function capToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  // Mark the cut. A silently shortened result reads as complete data — a model
  // asked "how many variants" would count what survived and answer confidently
  // wrong — and whoever debugs it has no way to tell truncation from a short
  // record. The marker costs its own length back so the total still fits.
  return (
    result.slice(0, MAX_TOOL_RESULT_CHARS - TOOL_RESULT_TRUNCATION_MARKER.length) +
    TOOL_RESULT_TRUNCATION_MARKER
  );
}

/**
 * Coerce a tool call's input to the wire schema's args record. The AI SDK
 * surfaces an unparsable/invalid tool call as a `tool-call` part whose
 * `input` is the raw argument string (or any JSON value), not a parsed
 * object — shipping that verbatim fails the `tool_call` / sync `toolCalls`
 * schemas, which require a record. Anything that isn't a plain object
 * becomes `{}` so one bad call degrades to empty args instead of
 * invalidating the whole frame or response.
 *
 * @internal
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
 *
 * @internal
 */
export function isTextAssetPath(assetPath: string): boolean {
  const dot = assetPath.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_ASSET_EXTENSIONS.has(assetPath.slice(dot + 1).toLowerCase());
}

/**
 * Typographic characters that a text-to-speech engine should never see, mapped
 * to their ASCII equivalents.
 *
 * **Every entry must be a single UTF-16 code unit mapping to a single code
 * unit.** The heard cursor indexes a reply's TTS text by `text.length`
 * (`spans.push({ len: text.length })` in `host/transports/pipeline-heard.ts`),
 * and that index is what decides which words history records as heard and
 * where a false-interruption resume picks up. A substitution that changed
 * length would silently shift both. That rules out the tempting additions —
 * an ellipsis to three dots, a dash to a spelled word — and they are unwanted
 * anyway: `—` and `…` carry PROSODY, and TTS engines already render them as
 * pauses.
 *
 * Scoped to the quote/apostrophe family for that reason: those characters
 * carry no prosody, and they are what an LLM actually emits. Model output is
 * full of them — `You’re`, `I’ll`, `don’t` — because the training data is
 * typeset prose, and a curly apostrophe is a different codepoint from the
 * straight one every pronunciation lexicon is keyed on.
 */
const SPEECH_CHAR_MAP: ReadonlyMap<string, string> = new Map([
  ["‘", "'"], // ‘ left single quote
  ["’", "'"], // ’ right single quote — the apostrophe LLMs emit
  ["‚", "'"], // ‚ single low-9 quote
  ["‛", "'"], // ‛ single high-reversed-9 quote
  ["ʼ", "'"], // ʼ modifier letter apostrophe
  ["′", "'"], // ′ prime
  ["“", '"'], // “ left double quote
  ["”", '"'], // ” right double quote
  ["„", '"'], // „ double low-9 quote
  ["″", '"'], // ″ double prime
  ["‟", '"'], // ‟ double high-reversed-9 quote
]);

/** Character class matching every key of {@link SPEECH_CHAR_MAP}. */
const SPEECH_CHARS = /[‘’‚‛ʼ′“”„″‟]/g;

/**
 * Normalize text on its way to a TTS engine: typographic quotes and
 * apostrophes become their ASCII equivalents.
 *
 * Applied at the single point where the pipeline hands text to the provider,
 * so it covers model output, the greeting, the error phrase and the dead-air
 * filler alike. **Length-preserving by construction** — see
 * {@link SPEECH_CHAR_MAP} for why that is load-bearing rather than incidental.
 *
 * Returns the input unchanged (same reference) when there is nothing to
 * replace, which is the common case for a reply with no contractions.
 */
export function normalizeSpeechText(text: string): string {
  SPEECH_CHARS.lastIndex = 0;
  if (!SPEECH_CHARS.test(text)) return text;
  return text.replace(SPEECH_CHARS, (c) => SPEECH_CHAR_MAP.get(c) ?? c);
}
