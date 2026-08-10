// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared utility functions (the `@alexkroman1/aai/utils` subpath).
 *
 * For user tool code: `errorMessage`, `errorDetail`, `safeJsonParse`,
 * `toolError`, `isToolFailure`, `pushCapped`, and `createKeyedLock`. The
 * remaining exports are framework
 * plumbing shared with the sibling packages. The module stays free of zod and
 * other heavy runtime dependencies so the CLI can import it on every
 * invocation without a startup cost.
 *
 * That zod-free property is why `omitUndefined` lives here rather than on
 * `/internal` alongside the other cross-package infrastructure: `/internal`
 * re-exports `formatSchemaIssues` from `sdk/schema.ts`, so importing anything
 * from it pulls zod — and the CLI's own `_utils.ts` is on the startup path.
 *
 * `createKeyedLock` is the one export with a runtime dependency (`p-timeout`,
 * for its optional acquire deadline). Deliberate, and measured against the
 * rule above rather than around it: p-timeout is 2.4 KB with an empty
 * dependency list, where the cost this rule exists to keep off the startup
 * path is zod's module graph. It belongs on the PUBLIC subpath because the
 * hazard it addresses is an agent author's — the LLM loop runs a step's tool
 * calls concurrently, so two async mutators of one `ctx.state` interleave —
 * and `/internal` would be telling users to import internal API.
 *
 * @module utils
 */

import { MAX_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_MARKER } from "./constants.ts";

export { linkConfirmationCode } from "./cli-link.ts";
export {
  createKeyedLock,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  withLock,
} from "./keyed-lock.ts";
export { omitUndefined } from "./omit-undefined.ts";
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
 * `'{"error":"<message>"}'`.
 *
 * @remarks
 * This is the PRE-SERIALIZED wire form, which is what the host itself emits
 * for a tool that threw or could not be dispatched. Tool authors want
 * {@link ToolFailure} instead — return the object `{ error: message }` and the
 * runtime serializes it, so the value stays inspectable by the tool's own
 * callers and its tests. `isToolFailure` does NOT narrow this function's
 * string result.
 */
export function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * A tool result that reports a recoverable failure to the LLM.
 *
 * Return one from `execute` (instead of throwing) when the failure is
 * something the model should see and act on — "no order matches that
 * description, ask which one" — rather than an internal fault. The runtime
 * serializes it like any other result, so it reaches the model as
 * `{"error":"…"}` and reaches a test as an inspectable object.
 *
 * A tool that returns failures declares them in its own result union
 * (`Order | ToolFailure`), which is what makes {@link isToolFailure} a
 * narrowing guard at every call site that forwards one.
 *
 * @public
 */
export type ToolFailure = { error: string };

/**
 * Whether a value is a {@link ToolFailure}.
 *
 * The guard exists because failures PROPAGATE: a helper resolving an order
 * returns `Order | ToolFailure`, and its caller forwards the failure
 * unchanged rather than re-wording it. `if ("error" in value)` works only
 * once the value is known to be an object, which is the check this bundles.
 *
 * @example
 * ```ts
 * import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
 *
 * type Order = { id: string; total: number };
 *
 * function findOrder(id: string): Order | ToolFailure {
 *   return { error: `Order ${id} not found.` };
 * }
 *
 * function orderTotal(id: string): number | ToolFailure {
 *   const order = findOrder(id);
 *   if (isToolFailure(order)) return order;
 *   return order.total;
 * }
 * ```
 *
 * @public
 */
export function isToolFailure(value: unknown): value is ToolFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

/**
 * Append to a list, dropping the oldest entries so it never exceeds `max`.
 * Mutates `list` in place and returns it.
 *
 * For the append-only lists an agent keeps in `ctx.state` — a timeline, an
 * activity feed, a session log. Every one of them feeds an LLM summary or a
 * `syncState` payload, so an uncapped list grows what the model reads and
 * what crosses the wire for the length of the call, unboundedly. In place
 * rather than returning a new array because the list is usually a property of
 * the state object (`incident.timeline`), and reassigning that is a second
 * thing to remember.
 *
 * `max` below 1 keeps nothing — including the entry just appended — which is
 * what "a cap of zero" has to mean.
 *
 * @example
 * ```ts
 * import { pushCapped } from "@alexkroman1/aai";
 *
 * const log: string[] = ["a", "b", "c"];
 * pushCapped(log, "d", 3); // ["b", "c", "d"]
 * ```
 *
 * @public
 */
export function pushCapped<T>(list: T[], item: T, max: number): T[] {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - Math.max(max, 0));
  return list;
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
 * filler alike.
 *
 * **Length-preserving by construction, and that is load-bearing.** The heard
 * cursor indexes a reply's TTS text by `text.length`
 * (`host/transports/pipeline-heard.ts`), and that index decides which words
 * history records as heard and where a false-interruption resume picks up, so
 * a substitution that changed length would silently shift both. Scoped to the
 * quote/apostrophe family for the same reason: `—` and `…` would break the
 * invariant, and they carry PROSODY that engines already render as pauses.
 *
 * Returns the input unchanged (same reference) when there is nothing to
 * replace, which is the common case for a reply with no contractions.
 */
export function normalizeSpeechText(text: string): string {
  SPEECH_CHARS.lastIndex = 0;
  if (!SPEECH_CHARS.test(text)) return text;
  return text.replace(SPEECH_CHARS, (c) => SPEECH_CHAR_MAP.get(c) ?? c);
}
