// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.poll` — the one loop every "wait for the far side" workflow writes: check
 * in a step, sleep durably, check again, until the answer is in or the budget is
 * spent.
 *
 * Composed ENTIRELY of `ctx.step`, `ctx.sleep` and `ctx.waitFor`, so it has no
 * journal shape of its own: a poll named `"check"` journals `check#0`,
 * `sleep!check#0`, `check#1`, … exactly as the hand-written loop did, and a run
 * started under the loop replays under this. Every `WorkflowContext` (the replay
 * engine's, the `/testing` recorder, an eval's) implements `poll` by calling
 * this, so the three cannot disagree about how many checks a budget buys.
 *
 * The budget is a COUNT (`floor(maxMs / everyMs)` sleeps), not a clock. A clock
 * would need a journaled `ctx.now()` per iteration to stay replay-safe; a count
 * is replay-safe by construction and is what every hand-written copy computed
 * anyway (`MAX_POLLS = ceil(limit / POLL_MS)`).
 *
 * Two conveniences ride the same rule. `first` is one `ctx.waitFor` AHEAD of
 * the loop, journaled as that call is (`hook!<token>#0` and its deadline), and
 * whether it was answered is reported rather than branched on — the branch a
 * body wrote on the journaled submit result was the thing that diverged.
 * `slowAfterMs` is a single `stepReport` in its own step (`<name>:slow`), taken
 * after a COUNT of sleeps, so a replay neither repeats the line nor moves it.
 *
 * @internal — reached by a host through `@alexkroman1/aai/host-internal`; an
 * author calls `ctx.poll`.
 */

import { omitUndefined } from "./omit-undefined.ts";
import type {
  PollOptions,
  PollResult,
  StepOptions,
  WaitForOptions,
} from "./workflow-ctx-options.ts";
import { reportWorkflow } from "./workflow-report.ts";

/**
 * The three context methods a poll is made of, with the NAME unconstrained.
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
  waitFor(token: string, options: WaitForOptions): Promise<unknown>;
};

/** Refuse a budget no loop can honour — deterministically, so the run fails at the call. */
function assertPollOptions<T>(name: string, options: PollOptions<T>): void {
  if (!(Number.isFinite(options.everyMs) && options.everyMs >= 1)) {
    throw new RangeError(`ctx.poll("${name}"): everyMs must be a finite number of at least 1`);
  }
  if (!(Number.isFinite(options.maxMs) && options.maxMs >= 0)) {
    throw new RangeError(`ctx.poll("${name}"): maxMs must be a finite, non-negative number`);
  }
  const slow = options.slowAfterMs;
  if (slow !== undefined && !(Number.isFinite(slow) && slow >= 0)) {
    throw new RangeError(`ctx.poll("${name}"): slowAfterMs must be a finite, non-negative number`);
  }
}

/**
 * The sleep count at which the slow line is written, or `undefined` for never.
 *
 * `ceil`, so a `slowAfterMs` shorter than one interval fires after the FIRST
 * sleep rather than before any wait has been taken.
 */
function slowAfterSleeps<T>(options: PollOptions<T>): number | undefined {
  if (options.slowAfterMs === undefined) return undefined;
  return Math.max(1, Math.ceil(options.slowAfterMs / options.everyMs));
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
  const slowAt = slowAfterSleeps(options);
  const stepOptions: StepOptions = omitUndefined({ maxAttempts: options.maxAttempts });
  // Journaled as the one `waitFor` the hand-written body made ahead of its
  // loop — the poll adds no key of its own. `woken` is the answer a body used
  // to derive by branching, which is why it is REPORTED here instead.
  const woken: { woken?: boolean } = {};
  if (options.first !== undefined) {
    const { waitFor, timeoutMs, schema } = options.first;
    // No token means no callback was issued (`stepWebhookUrl` optional on a
    // deployment with no public URL): nothing to park on, so the first check
    // runs now — and the journal sees no wait, exactly as a body that
    // branched on the URL would have written it.
    const payload =
      waitFor === undefined
        ? undefined
        : await host.waitFor(waitFor, { timeoutMs, ...omitUndefined({ schema }) });
    woken.woken = payload !== undefined;
  }
  for (let checks = 1; ; checks++) {
    const value = await host.step(name, check, stepOptions);
    if (options.done(value)) return { value, done: true, checks, ...woken };
    if (checks > maxSleeps) return { value, done: false, checks, ...woken };
    // A DURATION, journaled at first reach — so a replay finds the same wake
    // time rather than pushing it out by however long the walk took.
    await host.sleep(name, options.everyMs);
    // Its own journaled step, AFTER the sleep that reached the count: written
    // once, on the walk that first gets here, and answered from the journal on
    // every later one.
    if (slowAt !== undefined && checks === slowAt) {
      await reportWorkflow(host, `${name}:slow`, options.onSlow ?? `Still waiting on ${name}.`);
    }
  }
}
