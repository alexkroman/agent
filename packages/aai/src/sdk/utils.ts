// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared utility functions (the `@alexkroman1/aai/utils` subpath).
 *
 * For user tool code: `errorMessage`, `errorDetail`, `safeJsonParse`,
 * `toolFailure`, `isToolFailure`, `pushCapped`, `createKeyedLock`,
 * `decodeHtmlEntities`, and the five
 * narration formatters (`formatBytes`, `formatDuration`, `formatMoney`,
 * `countWords`, `plural`). The remaining exports are framework
 * plumbing shared with the sibling packages. The module stays free of zod and
 * other heavy runtime dependencies so the CLI can import it on every
 * invocation without a startup cost.
 *
 * That budget is also why `stepSpeak` is here at all rather than beside the TTS
 * providers: the synthesizer needs a WebSocket client, so what this module
 * carries is the SLOT and the WAV framing — the same split `stepFetch` makes
 * with its undici dispatcher, and for the same measured reason.
 *
 * That zod-free property is why `omitUndefined` lives here rather than on
 * `/internal` alongside the other cross-package infrastructure: `/internal`
 * re-exports a schema helper that pulls zod, so importing anything from it pulls
 * zod's whole module graph — and the CLI loads this module on every invocation.
 *
 * `createKeyedLock` is the one export with a runtime dependency (`p-timeout`,
 * for its optional acquire deadline). Deliberate, and measured against the
 * rule above rather than around it: p-timeout is 2.4 KB with an empty
 * dependency list, where the cost this rule exists to keep off the startup
 * path is zod's module graph. It belongs on the PUBLIC subpath because the
 * hazard it addresses is an agent author's — the LLM loop runs a step's tool
 * calls concurrently, so two async mutators of one external resource interleave
 * — and `/internal` would be telling users to import internal API. (Per-session
 * state is not that case any more: `sessionSlot`'s `update` window is
 * synchronous, so it has nothing to serialize.)
 *
 * @module utils
 */

import { isRecord } from "./is-record.ts";
import { previewBody, statusWithPreview } from "./response-body.ts";
import { safeJsonParse } from "./safe-json-parse.ts";
// Imported as well as re-exported: the functions below call them, and a
// re-export does not bring the name into this module's scope.
import { formatSchemaIssues, type StandardSchemaIssue } from "./standard-schema.ts";

/**
 * The narration formatters — a byte count, a clock reading, a word count, and
 * an English plural.
 *
 * Their own module because they are a set with one shared argument (see
 * `format.ts`), and re-exported from here rather than given a subpath of their
 * own because `/utils` is already the import a template's `client.tsx` and its
 * `workflows/*.ts` both reach for, and these four are used from both.
 */
export { countWords, formatBytes, formatDuration, formatMoney, plural } from "./format.ts";
/**
 * The one entity decoder, for a step reading text off somebody else's markup.
 *
 * Its own module for the same reason `format.ts` is: two templates had written
 * it, and the thing they both had to get right — `&amp;` decoded last — is the
 * whole content of the function. See `html-entities.ts`.
 */
export { decodeHtmlEntities } from "./html-entities.ts";
export { isRecord } from "./is-record.ts";
export {
  createKeyedLock,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  withLock,
} from "./keyed-lock.ts";
export { omitUndefined } from "./omit-undefined.ts";
export { safeJsonParse } from "./safe-json-parse.ts";

/**
 * Extract an error message from an unknown thrown value.
 *
 * **It never answers with an empty string.** That is the contract, and it is
 * worth stating as one: `SessionError.message` is rendered directly by a
 * browser client, so `""` paints a banner that says an error occurred and
 * refuses to say what — strictly worse than a generic sentence, because an
 * absent message reads as absence rather than as a problem.
 *
 * The shape that produced one is not exotic, it is the FIRST failure a new
 * project hits. The AI SDK builds an `APICallError` whose `message` is
 * `response.statusText` whenever the provider's error body does not match the
 * schema it expected (`createJsonErrorResponseHandler`), and a reason phrase is
 * optional in HTTP/1.1 and does not exist at all in HTTP/2 — so a rejected API
 * key arrived as `{"code":"llm","message":"","fatal":false}` with the status,
 * the URL, and the provider's own explanation all sitting unread on the error
 * object.
 *
 * So a value that says nothing on its own is read one level down, in this
 * order: the HTTP fields an `APICallError`-shaped failure carries (the status,
 * the host that answered, the sentence in the response body), then `cause`,
 * then an `AggregateError`'s members. Detection is STRUCTURAL for the same
 * reason the schema-issue reading below it is — this module is published,
 * zod-free, and may not import `ai` to ask `APICallError.isInstance` — and it
 * costs nothing: a numeric `statusCode` beside a `responseBody` is the shape,
 * whoever built it.
 *
 * An error that DOES state something keeps its own words — an HTTP failure has
 * the status appended to them, since `Unauthorized` alone answers neither "which
 * provider" nor "refused or fell over", and everything else is returned
 * verbatim. One message is replaced outright, and it has precedent:
 * `fetch failed` (and the browser's `failed to fetch`) is
 * Node's own placeholder, with the reason — `ECONNREFUSED`, a DNS failure, a
 * certificate rejection — one level down in `cause`. The AI SDK makes exactly
 * this substitution for its own calls (`handleFetchError`, which rewrites the
 * pair as "Cannot connect to API: …"); this extends the same reading to every
 * direct `fetch` in the SDK.
 *
 * @public
 */
export function errorMessage(err: unknown): string {
  return describeError(err, new Set()) ?? lastResortMessage(err);
}

/**
 * The two placeholders a failed `fetch` throws — Node's and the browser's.
 *
 * Lower-cased for comparison; the same pair the AI SDK's `handleFetchError`
 * keys off.
 */
const OPAQUE_FETCH_MESSAGES: ReadonlySet<string> = new Set(["fetch failed", "failed to fetch"]);

/** What {@link errorMessage} says when the thrown value carried nothing at all. */
const UNKNOWN_ERROR = "Unknown error";

/**
 * The best sentence a value states about itself, or `undefined` when it states
 * none — the recursive half of {@link errorMessage}.
 *
 * `seen` is not defensive bookkeeping: a `cause` chain really can be cyclic
 * (an error re-thrown with itself as its own cause is a two-line mistake), and
 * this walks it.
 */
function describeError(err: unknown, seen: Set<unknown>): string | undefined {
  if (isRecord(err)) {
    if (seen.has(err)) return undefined;
    seen.add(err);
  }
  const issues = schemaIssuesOf(err);
  if (issues !== undefined) return formatSchemaIssues(issues);
  const http = httpFailureMessage(err, seen);
  if (http !== undefined) return http;
  const own = statedMessage(err);
  if (own !== undefined && !OPAQUE_FETCH_MESSAGES.has(own.toLowerCase())) return own;
  const inherited = inheritedMessage(err, seen);
  if (inherited === undefined) return own;
  if (own === undefined || inherited.includes(own)) return inherited;
  return `${own}: ${inherited}`;
}

/** A value's own `message`, trimmed, or `undefined` when it has none worth reading. */
function statedMessage(err: unknown): string | undefined {
  if (!isRecord(err) || typeof err.message !== "string") return undefined;
  const text = err.message.trim();
  return text === "" ? undefined : text;
}

/**
 * The sentence an HTTP failure carries, or `undefined` if this is not one.
 *
 * The status is ALWAYS included, even when the error states a message: "which
 * provider, and did it refuse the credential or fall over" is what the reader
 * needs, and `Unauthorized` on its own answers neither.
 */
function httpFailureMessage(err: unknown, seen: Set<unknown>): string | undefined {
  if (!isRecord(err) || typeof err.statusCode !== "number" || !Number.isFinite(err.statusCode)) {
    return undefined;
  }
  const host = hostOf(err.url);
  const where = `HTTP ${err.statusCode}${host === undefined ? "" : ` from ${host}`}`;
  const detail =
    statedMessage(err) ??
    bodyMessage(err.responseBody) ??
    bodyMessage(err.data) ??
    inheritedMessage(err, seen);
  return detail === undefined ? where : `${detail} (${where})`;
}

/**
 * The explanation a provider put in its error BODY.
 *
 * Every JSON API in this stack's dependency tree spells it one of four ways —
 * `{"error":{"message":…}}` (OpenAI and everything compatible with it),
 * `{"error":…}` (this SDK's own routes), `{"message":…}`, `{"detail":…}`
 * (FastAPI) — so the four are read in turn and anything else falls back to a
 * capped preview of the raw body, which at least identifies whatever answered.
 */
function bodyMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    const text = body.trim();
    if (text === "") return undefined;
    return bodyMessage(safeJsonParse(text)) ?? previewBody(text);
  }
  if (!isRecord(body)) return undefined;
  for (const field of [body.error, body.message, body.detail]) {
    const text = typeof field === "string" ? field.trim() : (statedMessage(field) ?? "");
    if (text !== "") return text;
  }
  return undefined;
}

/** What a value's `cause`, or an `AggregateError`'s members, say instead. */
function inheritedMessage(err: unknown, seen: Set<unknown>): string | undefined {
  if (!isRecord(err)) return undefined;
  if (err.cause !== undefined && err.cause !== null) {
    const fromCause = describeError(err.cause, seen);
    if (fromCause !== undefined) return fromCause;
  }
  if (!Array.isArray(err.errors)) return undefined;
  const parts = err.errors
    .map((member: unknown) => describeError(member, seen))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** The host that answered, for naming the provider in a failure. */
function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    // Not an absolute URL — the status alone is still worth reporting.
    return undefined;
  }
}

/**
 * The last thing to say about a value that states nothing: its class, or its
 * own stringification, and never the empty string.
 *
 * `Error (no message)` beats `String(err)`'s bare `Error` because a lone class
 * name reads as a message someone wrote; the parenthetical says the error
 * carried none, which is the actual finding.
 */
function lastResortMessage(err: unknown): string {
  if (isRecord(err) && typeof err.name === "string" && err.name.trim() !== "") {
    return `${err.name.trim()} (no message)`;
  }
  const text = stringify(err);
  return text === "" || text === "[object Object]" ? UNKNOWN_ERROR : text;
}

/** `String(value)`, for a value whose `toString` may itself be hostile. */
function stringify(value: unknown): string {
  try {
    return String(value).trim();
  } catch {
    return "";
  }
}

/**
 * The validation issues of a schema error, or `undefined` for anything else.
 *
 * Structural rather than `instanceof ZodError`, because the error can come from
 * any validator in the chain (and, on the CLI, from a server that serialized
 * one) — and because `sdk/utils.ts` is a published subpath that must not drag a
 * validator in.
 *
 * The reason this is worth a branch at all: a `ZodError`'s own `message` is
 * `JSON.stringify(issues, null, 2)`. Every caller that reports an error by its
 * message — the CLI's top-level handler, a log line, a tool's failure string —
 * printed a twelve-line array of `{ "origin", "code", "path" }` objects for one
 * wrong field, in place of the sentence the issue already carries.
 */
function schemaIssuesOf(err: unknown): readonly StandardSchemaIssue[] | undefined {
  if (!(isRecord(err) && Array.isArray(err.issues)) || err.issues.length === 0) return undefined;
  const issues = err.issues;
  return issues.every((issue) => isRecord(issue) && typeof issue.message === "string")
    ? (issues as readonly StandardSchemaIssue[])
    : undefined;
}

/** Extract a detailed error string (message + stack) for diagnostic logging. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
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
 * Build a {@link ToolFailure} — the failure a tool `execute` RETURNS when the
 * model should see it and recover.
 *
 * The pair to {@link isToolFailure}, and named to say so. The object literal
 * `{ error: message }` means exactly the same thing and stays perfectly good
 * TypeScript; this exists so that a tool reaching for "how do I report a
 * failure?" finds the constructor next to the guard rather than the framework's
 * own internal wire form, which is a pre-serialized string this guard does not
 * narrow.
 *
 * @example
 * ```ts
 * import { tool, toolFailure } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const orders = new Map<string, { id: string; total: number }>();
 *
 * export const orderTotal = tool({
 *   description: "Look up an order's total",
 *   inputSchema: z.object({ id: z.string() }),
 *   execute: ({ id }) => {
 *     const order = orders.get(id);
 *     if (!order) return toolFailure(`Order ${id} not found.`);
 *     return { total: order.total };
 *   },
 * });
 * ```
 *
 * @public
 */
export function toolFailure(message: string): ToolFailure {
  return { error: message };
}

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
  return isRecord(value) && typeof value.error === "string";
}

/**
 * Read a failed `Response`'s error sentence — the one every route this SDK
 * serves answers with.
 *
 * Each `4xx`/`5xx` an agent produces carries `{ "error": "<sentence>" }`, and
 * that sentence is the whole diagnostic: an unknown workflow names the ones
 * that are declared, a rejected input names the schema issues, a 404 from an
 * agent that declares no workflows names both of its causes. Anything ELSE in
 * the path — a proxy, a CDN, a platform broker answering while a sandbox boots
 * — replies with a body that shape does not fit, so the status is reported
 * instead, with a short preview of whatever did come back.
 *
 * `label` names the surface that answered and appears ONLY in that fallback:
 * when the agent gave its own sentence, prefixing it would put our words in
 * front of the ones worth reading.
 *
 * It never throws and never rejects — a body that cannot be read at all
 * degrades to the bare status, because this runs on a path that is already
 * reporting a failure and a second one there has nowhere to go.
 *
 * It deliberately does NOT reuse {@link isToolFailure}, whose object shape is
 * identical today: that guard answers for a TOOL's result union, and the two
 * contracts are free to move apart.
 *
 * @example
 * ```ts
 * import { responseErrorMessage } from "@alexkroman1/aai/utils";
 *
 * async function startRun(url: string): Promise<string> {
 *   const res = await fetch(url, { method: "POST" });
 *   if (!res.ok) throw new Error(await responseErrorMessage(res, "Workflow API"));
 *   return ((await res.json()) as { runId: string }).runId;
 * }
 * ```
 *
 * @public
 */
export async function responseErrorMessage(res: Response, label?: string): Promise<string> {
  const text = await res.text().catch(() => "");
  const body = safeJsonParse(text);
  if (isRecord(body)) {
    const { error } = body;
    // An empty sentence is not a diagnostic — fall through to the status,
    // which at least says what happened.
    if (typeof error === "string" && error !== "") return error;
  }
  return statusWithPreview(res.status, text, label);
}

/**
 * Append to a list, dropping the oldest entries so it never exceeds `max`.
 * Mutates `list` in place and returns it.
 *
 * For the append-only lists an agent keeps in a `sessionSlot` — a timeline, an
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
