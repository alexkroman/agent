// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.poll` — the one loop every "wait for the far side" workflow writes: check
 * in a step, sleep durably, check again, until the answer is in or the budget is
 * spent.
 *
 * Composed ENTIRELY of `ctx.step` and `ctx.sleep`, so it has no journal shape of
 * its own: a poll named `"check"` journals `check#0`, `sleep!check#0`,
 * `check#1`, … exactly as the hand-written loop did, and a run started under the
 * loop replays under this. Every `WorkflowContext` (the replay engine's, the
 * `/testing` recorder, an eval's) implements `poll` by calling this, so the
 * three cannot disagree about how many checks a budget buys.
 *
 * The budget is a COUNT (`floor(maxMs / everyMs)` sleeps), not a clock. A clock
 * would need a journaled `ctx.now()` per iteration to stay replay-safe; a count
 * is replay-safe by construction and is what every hand-written copy computed
 * anyway (`MAX_POLLS = ceil(limit / POLL_MS)`).
 *
 * @internal — reached by a host through `@alexkroman1/aai/host-internal`; an
 * author calls `ctx.poll`.
 */

import { omitUndefined } from "./omit-undefined.ts";
import type { PollOptions, PollResult, StepOptions } from "./workflow-ctx-options.ts";

/**
 * The two context methods a poll is made of, with the NAME unconstrained.
 *
 * `WorkflowContext.step`/`sleep` refuse a non-literal name at compile time; the
 * poll's own name was a literal at the author's call site, so it is re-checked
 * nowhere here. Method syntax, so a `WorkflowContext` is assignable to it.
 *
 * @internal
 */
export type PollHost = {
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  sleep(label: string, until: number | Date): Promise<void>;
};

/** Refuse a budget no loop can honour — deterministically, so the run fails at the call. */
function assertPollOptions<T>(name: string, options: PollOptions<T>): void {
  if (!(Number.isFinite(options.everyMs) && options.everyMs >= 1)) {
    throw new RangeError(`ctx.poll("${name}"): everyMs must be a finite number of at least 1`);
  }
  if (!(Number.isFinite(options.maxMs) && options.maxMs >= 0)) {
    throw new RangeError(`ctx.poll("${name}"): maxMs must be a finite, non-negative number`);
  }
}

/**
 * Run one poll over `host`.
 *
 * @internal
 */
export async function pollWorkflow<T>(
  host: PollHost,
  name: string,
  check: () => Promise<T> | T,
  options: PollOptions<T>,
): Promise<PollResult<T>> {
  assertPollOptions(name, options);
  const maxSleeps = Math.floor(options.maxMs / options.everyMs);
  const stepOptions: StepOptions = omitUndefined({ maxAttempts: options.maxAttempts });
  for (let checks = 1; ; checks++) {
    const value = await host.step(name, check, stepOptions);
    if (options.done(value)) return { value, done: true, checks };
    if (checks > maxSleeps) return { value, done: false, checks };
    // A DURATION, journaled at first reach — so a replay finds the same wake
    // time rather than pushing it out by however long the walk took.
    await host.sleep(name, options.everyMs);
  }
}
