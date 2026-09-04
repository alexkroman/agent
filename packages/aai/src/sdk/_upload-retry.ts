// Copyright 2026 the AAI authors. MIT license.
/**
 * Sending an upload request again when the far side said COME BACK.
 *
 * Split from `workflow-upload-parts.ts` for the line cap, and the seam is a real
 * one: what belongs here is the vocabulary of "is this an answer or a wait", which
 * every request on that path shares — the claim in front of the fan-out, each
 * part, and the record read after it.
 *
 * The one thing it deliberately does NOT own is the ERROR: `withRetries` returns
 * the last response whatever it says, so the caller turns a refusal into its own
 * failure. A second error vocabulary for this route is exactly what
 * `workflow-upload-client.ts` exists to prevent.
 */

import { jitteredBackoff } from "./jittered-backoff.ts";
import { sleep } from "./sleep.ts";
import { retryAfter } from "./step-retry.ts";
import { UPLOAD_RETRY_BASE_MS, UPLOAD_RETRY_MAX_MS } from "./upload-constants.ts";

/**
 * Statuses that mean "come back", as opposed to "no".
 *
 * A part is disjoint from every other and the store keys its rows by offset, so
 * re-sending one is idempotent by construction — which is what makes retrying
 * safe here even for a 500, where a caller mutating something would have to
 * wonder whether it had already happened. 408 and 425 are on the list for the
 * same reason as 503: they name the request's TIMING rather than its content.
 */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * How long to wait before re-sending, given the answer and how many tries it took.
 *
 * `Retry-After` first, because the far side knows something this does not: a whole
 * fan-out hits a capacity limit together, so an agreed-on delay is the difference
 * between four connections draining and four connections asking again in unison.
 * That is the same reasoning `toStepError` follows on the step side, and this path
 * was the asymmetry — it re-sent IMMEDIATELY into a 503 whose body says "retry
 * shortly".
 *
 * Otherwise {@link jitteredBackoff} — exponential, with jitter over the lower
 * half of the window so the parts that failed together do not come back
 * together. Both are capped by {@link UPLOAD_RETRY_MAX_MS}, `Retry-After`
 * included: this endpoint is the app's own agent, its 503s carry single-digit
 * seconds, and a page whose upload bar stops for two minutes on one it does not
 * is a page a person reloads.
 */
function retryDelay(attempt: number, res: Response | undefined): number {
  const asked = res && retryAfter(res);
  if (asked) return Math.min(Math.max(0, asked.getTime() - Date.now()), UPLOAD_RETRY_MAX_MS);
  return jitteredBackoff(attempt, {
    baseMs: UPLOAD_RETRY_BASE_MS,
    maxMs: UPLOAD_RETRY_MAX_MS,
  });
}

/**
 * Issue a request, re-sending it while the far side says "come back".
 *
 * Returns the last response whatever it says — an `ok`, a refusal, or a "come
 * back" that outlived the budget — so the ERROR vocabulary stays with the caller,
 * which is the one thing this module must not own a second copy of. It throws only
 * what the transport threw, and only once there is nothing left to try.
 *
 * `attempts` is reported back because one caller has to know whether it retried:
 * see the 409 in {@link uploadInParts}.
 */
export async function withRetries(
  issue: () => Promise<Response>,
  opts: { attempts: number; signal: AbortSignal },
): Promise<{ res: Response; attempts: number }> {
  for (let attempt = 1; ; attempt += 1) {
    let res: Response | undefined;
    try {
      res = await issue();
    } catch (err: unknown) {
      // A transport failure — the case parts are most exposed to. Re-thrown once
      // the budget is out, and immediately on an abort, which is an ANSWER rather
      // than a failure to retry past.
      if (attempt >= opts.attempts || opts.signal.aborted) throw err;
    }
    // An answer, either way: a success, or a refusal that will be a refusal again.
    // Telling those apart from a "come back" is the difference between one part
    // being re-sent and the whole upload ending — see the module doc.
    if (res && (res.ok || !RETRYABLE_STATUS.has(res.status))) return { res, attempts: attempt };
    // Out of budget with a "come back" in hand: the caller turns it into its own
    // error rather than this deciding what it means.
    if (res && attempt >= opts.attempts) return { res, attempts: attempt };
    await sleep(retryDelay(attempt, res), { signal: opts.signal });
    // `sleep` resolves rather than throwing on an abort, so the check is here.
    opts.signal.throwIfAborted();
  }
}
