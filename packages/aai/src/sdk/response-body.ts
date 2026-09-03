// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a `Response` body when whatever answered might not be the agent.
 *
 * Every route this SDK serves replies with JSON — `{ error }` on a failure, a
 * shape on a success — and every one of them can be answered by something else
 * instead: a proxy, a CDN, a load balancer, a platform broker holding the
 * request while a sandbox boots. Those reply HTML, or nothing, with any status
 * they like. So both halves of "read the body" need the same fallback, and this
 * module is that fallback in one place.
 *
 * ## Why the cap is here rather than beside `responseErrorMessage`
 *
 * There were three caps — `ERROR_BODY_PREVIEW_CHARS` in `sdk/utils.ts`,
 * `MAX_ERROR_BODY_CHARS` in `sdk/step-generate.ts`, `MAX_REPLY_PREVIEW_CHARS`
 * in `sdk/step-generate-json.ts` — all equal to 200 and all cutting
 * differently: two sliced silently, one appended an ellipsis. A silent cut is
 * the one that costs, because a proxy's whole HTML page and a truncated one
 * read identically to whoever is holding the log line, and a JSON envelope cut
 * mid-token looks malformed rather than long. Marking it is `capToolResult`'s
 * reasoning applied to a diagnostic.
 *
 * It is its OWN module rather than living beside `responseErrorMessage` for the
 * reason `is-record.ts` and `safe-json-parse.ts` are: `sdk/utils.ts` re-exports
 * `step-generate.ts` and `step-generate-json.ts`, so neither of those can
 * import from it.
 *
 * @module response-body
 */

import { safeJsonParse } from "./safe-json-parse.ts";

/**
 * Longest slice of a body a failure message quotes. Enough to identify a
 * proxy's HTML page or a gateway's JSON envelope without putting a whole
 * document into a log line or a toast.
 */
const BODY_PREVIEW_CHARS = 200;

/** Marks a cut, so a truncated quote cannot be read as the whole body. */
const PREVIEW_TRUNCATION_MARKER = "…";

/**
 * As much of a body as belongs in an error message, marked when it was cut.
 *
 * @internal
 */
export function previewBody(text: string): string {
  if (text.length <= BODY_PREVIEW_CHARS) return text;
  return `${text.slice(0, BODY_PREVIEW_CHARS)}${PREVIEW_TRUNCATION_MARKER}`;
}

/**
 * The sentence reported when a response did NOT carry this SDK's `{ error }`
 * shape: the status, optionally labelled with the surface that answered, plus a
 * preview of whatever did come back.
 *
 * One spelling, because two callers reach it by different routes — a non-2xx
 * (`responseErrorMessage`) and a 2xx whose body would not parse
 * ({@link readJsonBody}) — and a caller cannot tell those apart from the
 * message, which is the point: both mean "something other than the agent
 * answered this".
 *
 * @internal
 */
export function statusWithPreview(status: number, text: string, label?: string): string {
  const head = label === undefined ? `${status}` : `${label} ${status}`;
  return text ? `${head}: ${previewBody(text)}` : head;
}

/**
 * A 2xx body, parsed — or the same labelled failure a non-2xx would have given.
 *
 * **The status does not decide whether a body is JSON**, and `res.json()` on a
 * `200 text/html` rejects with a bare `SyntaxError` carrying no status, no
 * label, and none of the fields the caller was reading — which for a run's
 * `POST /runs` means losing the `runId` of a run the agent may already have
 * created, the one thing on that surface a caller cannot rebuild.
 *
 * @throws {Error} naming the surface, the status, and a preview of the body.
 * @internal
 */
export async function readJsonBody<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => "");
  const parsed = safeJsonParse(text);
  // `undefined` is unambiguous: JSON cannot encode it, so it is `safeJsonParse`
  // reporting malformed input rather than a body that really said `undefined`.
  if (parsed === undefined) throw new Error(statusWithPreview(res.status, text, label));
  return parsed as T;
}
