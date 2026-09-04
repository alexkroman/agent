// Copyright 2026 the AAI authors. MIT license.
/**
 * Exponential backoff with jitter over the lower half of the window — the one
 * spelling.
 *
 * Three modules had written it, in two packages, and all three bodies were the
 * same two lines:
 *
 * ```
 * const window = Math.min(BASE * 2 ** (attempt - 1), MAX);
 * return window / 2 + Math.random() * (window / 2);
 * ```
 *
 * `sdk/_upload-retry.ts` (re-sending one upload window), `sdk/_upload-resume.ts`
 * (re-entering a whole upload after an outage) and
 * `aai-runtime/_upload-blobs-brokered.ts` (a guest re-issuing one brokered byte
 * op). Two of them even named their local function `retryDelay`. Each carried
 * its own comment explaining the jitter, which is the tell this repo already
 * reads as a missing shared primitive — the same tell that produced `sleep()`,
 * `createKeyedLock()` and `omitUndefined()`.
 *
 * **The jitter is the half worth sharing, because it is the half a copy gets
 * wrong.** Callers that failed together retry together: a fan-out's concurrent
 * part uploads all meet one 503, two browser tabs meet one outage, a claim's
 * probes all meet one reset. A fixed schedule brings every one of them back to
 * the same still-recovering far side at the same instant, which is how a
 * transient failure becomes a sustained one. Spreading over the lower half of
 * the window keeps the doubling's shape (the wait still grows) while making the
 * exact instant unpredictable per caller, and it never waits LONGER than the
 * window it computed — the property that lets a caller reason about its total
 * budget from `base`, `max` and its attempt count alone.
 *
 * **What it deliberately does NOT own is `Retry-After`.** A far side that names
 * a delay knows something this cannot, so `_upload-retry.ts` prefers the header
 * and reaches here only when there is none. Folding that in would require a
 * `Response`, which the other two callers do not have — one of them is
 * re-entering after an error with no response at all.
 *
 * **One place computes this window WITHOUT jitter, on purpose.**
 * `aai-studio-client/src/use-event-stream.ts` reconnects the studio's SSE
 * subscription on the same `min(base * 2 ** (n - 1), max)` and stops there. It
 * is a real candidate — a server restart brings every open studio tab back in
 * unison, which is exactly the herd this spreads — but its spec asserts the
 * gaps EXACTLY (`[3000, 6000, 12_000]`), and trading that for a range
 * assertion is a bigger change than the one it buys. Convert it deliberately
 * or not at all; do not let it drift into a fourth copy of the jitter.
 *
 * On `@alexkroman1/aai/internal` rather than a published subpath: it is
 * infrastructure the sibling packages share, not something an `agent.ts`
 * composes against. Not `./host-internal`, which would also reach the runtime:
 * there is no host in this — it is arithmetic — and the next plausible caller
 * is the browser loop above. That subpath's zod-free rule is satisfied
 * trivially.
 *
 * @module
 */

/** How the window grows and where it stops. See {@link jitteredBackoff}. */
export type JitteredBackoffOptions = {
  /** The window for the FIRST attempt, doubling from there. */
  baseMs: number;
  /**
   * The largest window the doubling may reach, if any.
   *
   * Omitted means uncapped, which is only safe when the ATTEMPT COUNT is the
   * bound instead — `_upload-blobs-brokered.ts` is the one such caller, at
   * three attempts off a 250ms base, so its worst case is ~750ms by
   * construction. A caller that retries until a deadline needs a cap here, or
   * the doubling reaches minutes.
   */
  maxMs?: number | undefined;
};

/**
 * How long to wait before attempt `attempt + 1`, in milliseconds.
 *
 * `attempt` is 1-BASED — 1 is the wait after the first failure — because that
 * is what all three call sites already counted and an off-by-one here doubles
 * or halves every wait silently. The result is uniform over
 * `[window / 2, window)` where `window` is `baseMs * 2 ** (attempt - 1)`,
 * capped at `maxMs`.
 *
 * @example
 * ```ts
 * import { jitteredBackoff } from "@alexkroman1/aai/internal";
 *
 * declare const attempt: number;
 *
 * // 500ms base, 10s cap: ~250-500ms, then ~500-1000ms, then ~1-2s …
 * const waitMs = jitteredBackoff(attempt, { baseMs: 500, maxMs: 10_000 });
 * ```
 */
export function jitteredBackoff(attempt: number, options: JitteredBackoffOptions): number {
  const grown = options.baseMs * 2 ** (attempt - 1);
  const window = options.maxMs === undefined ? grown : Math.min(grown, options.maxMs);
  return window / 2 + Math.random() * (window / 2);
}
