// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepPollUntil` — the same check-and-wait loop as `ctx.poll`, INSIDE a step,
 * for a wait too short to be worth a durable sleep: a job the far side
 * finishes in seconds (an extraction, a transcode), where parking the run and
 * re-delivering it would cost more than holding the step.
 *
 * Nothing here is journaled — a step's internals never are — so the wait is an
 * ordinary timer, the clock is the wall clock, and a crash mid-poll re-runs
 * the step. That is the right trade exactly when the whole poll fits in a
 * step's lifetime; anything longer (minutes, a phone call) belongs to
 * `ctx.poll` in the body, which a step is not allowed to call.
 *
 * It stops early when the running step is cancelled: the wait resolves on the
 * step's signal and the abort is re-thrown, which is what the step's attempt
 * loop reads as a cancel rather than a failure.
 */

import { omitUndefined } from "./omit-undefined.ts";
import { sleep } from "./sleep.ts";
import { stepInfo } from "./step-attempt.ts";
import type { PollResult } from "./workflow-ctx-options.ts";

/**
 * Options for {@link stepPollUntil}.
 *
 * @public
 */
export type StepPollUntilOptions<T> = {
  /** Milliseconds to wait between two checks. At least 1. */
  everyMs: number;
  /**
   * Wall-clock budget in milliseconds, measured from the first check. No wait
   * starts that would end past it, so the poll returns `done: false` at or
   * before `maxMs` (plus the last check's own time).
   */
  maxMs: number;
  /** Is this check's value the answer? */
  done: (value: T) => boolean;
  /**
   * Stop waiting when this aborts — the abort's reason is thrown. Defaults to
   * the running step's own signal, so a cancelled run stops polling.
   */
  signal?: AbortSignal | undefined;
};

/**
 * Check `check()` every `everyMs` until `done(value)` holds or `maxMs` has
 * passed, inside a step, and resolve the last value.
 *
 * @example
 * ```ts
 * import { stepPollUntil } from "@alexkroman1/aai/step";
 *
 * declare function jobStatus(id: string): Promise<"PENDING" | "SUCCEEDED" | "FAILED">;
 *
 * export async function waitForExtraction(id: string): Promise<string> {
 *   const polled = await stepPollUntil(() => jobStatus(id), {
 *     everyMs: 3_000,
 *     maxMs: 60_000,
 *     done: (status) => status !== "PENDING",
 *   });
 *   if (polled.value === "FAILED") throw new Error(`extraction ${id} failed`);
 *   return polled.value;
 * }
 * ```
 *
 * @public
 */
export async function stepPollUntil<T>(
  check: () => Promise<T> | T,
  options: StepPollUntilOptions<T>,
): Promise<PollResult<T>> {
  const { everyMs, maxMs, done } = options;
  if (!(Number.isFinite(everyMs) && everyMs >= 1)) {
    throw new RangeError("stepPollUntil: everyMs must be a finite number of at least 1");
  }
  if (!(Number.isFinite(maxMs) && maxMs >= 0)) {
    throw new RangeError("stepPollUntil: maxMs must be a finite, non-negative number");
  }
  const signal = options.signal ?? stepInfo()?.signal;
  const deadline = Date.now() + maxMs;
  for (let checks = 1; ; checks++) {
    signal?.throwIfAborted();
    const value = await check();
    if (done(value)) return { value, done: true, checks };
    if (Date.now() + everyMs > deadline) return { value, done: false, checks };
    // `sleep` RESOLVES on an abort rather than rejecting; the check at the top of
    // the next round is what turns it into the throw.
    await sleep(everyMs, omitUndefined({ signal }));
  }
}
