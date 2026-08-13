// Copyright 2026 the AAI authors. MIT license.
/**
 * The two questions every step that calls an HTTP API has to answer: is another
 * attempt worth making, and how long should it wait?
 *
 * The Workflow DevKit retries a step that throws and gives up on a
 * `FatalError`, so a step body owns the split — and the split was hand-rolled
 * identically in every workflow template and in `step-generate.ts`, as a
 * four-status `isTransient`. That much is only worth extracting because it is
 * repeated. The DELAY is worth extracting because it was missing everywhere.
 *
 * ## A 429 usually says when to come back, and nothing was reading it
 *
 * The DevKit's own answer for a thrown `Error` is a short exponential backoff of
 * its own choosing. `RetryableError` (from `workflow`) takes a `retryAfter`
 * instead — and the far side of a rate limit has already told us the number:
 *
 * ```ts no-check
 * import { RetryableError } from "workflow";
 * import { isTransientStatus, retryAfter } from "@alexkroman1/aai/utils";
 *
 * if (!isTransientStatus(res.status)) throw new FatalError(message);
 * const at = retryAfter(res);
 * throw at ? new RetryableError(message, { retryAfter: at }) : new RetryableError(message);
 * ```
 *
 * That matters most exactly where this SDK encourages a fan-out: four segments
 * in flight against a per-minute limit will re-collect their 429s four at a time
 * on a backoff the server did not choose, where honouring the header drains
 * them. Nothing here throws `RetryableError` itself — it is the DevKit's, and
 * this module is on the CLI's zero-dependency startup path.
 */

/**
 * Will another attempt plausibly answer differently?
 *
 * `408` counts because it is the far side saying "too slow", not "no"; `429` and
 * every `5xx` are the ordinary transient pair. Everything else — a 400, a 401, a
 * 404 — answers the same way on the fourth attempt, and retrying it spends the
 * step's whole budget to arrive at the same failure several seconds later.
 *
 * @public
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * When the far side asked to be called back, as a `Date`.
 *
 * Reads `Retry-After` in both spellings RFC 9110 allows — delta-seconds
 * (`Retry-After: 30`) and an HTTP date (`Retry-After: Wed, 21 Oct 2026 07:28:00
 * GMT`) — and answers `undefined` for a header that is absent, unparsable, or in
 * the past. `undefined` is what a caller wants there: it means "you decide",
 * which is the DevKit's own backoff, rather than a date that would retry
 * instantly or never.
 *
 * @param from - A `Response`, or its headers. Both spellings are accepted
 *   because a caller holding only the headers should not have to fake a
 *   response to ask.
 * @public
 */
export function retryAfter(from: { headers: Headers } | Headers): Date | undefined {
  const headers = from instanceof Headers ? from : from.headers;
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  // Seconds first: it is the common form, and `Date.parse("30")` is a date in
  // some engines, so trying the date form first would silently mis-read it.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000) : undefined;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  // A date already past means "retry now"; the DevKit's own backoff is the
  // better answer than a deadline that has already expired.
  return at > Date.now() ? new Date(at) : undefined;
}
