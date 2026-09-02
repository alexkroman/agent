// Copyright 2026 the AAI authors. MIT license.
/**
 * The two durable WAITS a workflow body may reach: `ctx.sleep` and `ctx.waitFor`.
 *
 * Split out of `workflow-replay.ts` at the seam `createDeterminismReads` already
 * drew — a `Pick<WorkflowCtx, …>` factory bound to one walk, taking the walk's
 * journal, its suspension channel and its refusal callback. That file is the one
 * two changes at a time land in and it sits against the 500-line cap; naming the
 * waits took it over.
 *
 * ## A wait is keyed by NAME, and that is recent
 *
 * `sleep!<label>#<occurrence>` and `hook!<token>#<occurrence>` — name plus
 * occurrence, exactly like `ctx.step`. Two properties come out of that shape and
 * both are load-bearing:
 *
 * - **`!` is not producible by `${name}#${occurrence}`**, so an author's own
 *   `ctx.step("sleep")` (`sleep#0`) cannot alias a durable wait
 *   (`sleep!sleep#0`). The two key spaces are disjoint by construction rather
 *   than by convention, which is the same trick `workflow-replay-determinism.ts`
 *   uses for `now!`/`random!`/`uuid!`.
 * - **The occurrence goes LAST**, so `(name, occurrence)` is recoverable from the
 *   key by splitting at the final `#` however many a label or token carries.
 *
 * They were two bare ordinals, advanced only when a wait was REACHED, so a body
 * reaching a different NUMBER of waits read its predecessor's record — a
 * week-long `ctx.sleep` behind an `if` skipped in full with the clock unmoved and
 * the run reporting `completed`, and the `waitFor` version handing the body
 * another wait's PAYLOAD. `workflow-replay-divergence.ts` carries the residual:
 * a label or token that is ITSELF non-deterministic still mints a fresh key, so
 * the run parks on something nobody can signal — a hang rather than a wrong
 * answer, and nothing's job to catch.
 *
 * ## Nothing here THROWS a suspension
 *
 * A wait that has not elapsed hands back `slot.park(…)`, a promise that never
 * settles, and the walk suspends on a channel the body holds no reference to.
 * The `finally` closing the slot is what marks this engine operation done for
 * quiescence — see `workflow-replay-suspend.ts`. What DOES throw is a REFUSAL,
 * which is a verdict about the walk and travels through `refuse` as well, so a
 * body that catches broadly cannot turn one into `completed`.
 *
 * @module
 */

import type { SleepOptions, WaitForOptions, WorkflowCtx } from "@alexkroman1/aai";
import type { JournalStore } from "./workflow-journal-types.ts";
import { waitTokenDiverged } from "./workflow-replay-divergence.ts";
import type { SuspendController } from "./workflow-replay-suspend.ts";
import { waitInsideStep } from "./workflow-replay-wait.ts";

/**
 * The absolute moment a `sleep(label, until)` names.
 *
 * A `Date` is taken as given; a number is a DURATION from now. Read once, at the
 * first reach, and journaled — see `JournalStore.claimSleep`.
 */
function wakeAtFrom(until: number | Date): number {
  return until instanceof Date ? until.getTime() : Date.now() + until;
}

/** What {@link createWaitMethods} needs to answer one walk's waits. */
export type WaitOptions = {
  runId: string;
  journal: JournalStore;
  /**
   * Where a wait PARKS, and the channel the walk suspends on. One per walk, so
   * its suspension value is unique to this call and recognisable by identity.
   */
  suspend: SuspendController;
  /**
   * Record a refusal the ENGINE raised about this walk.
   *
   * A callback rather than a returned value because the refusal is also THROWN,
   * and `replayRun` holds the message so a body that catches broadly cannot turn
   * it into `completed` — the same contract a divergence and a determinism read
   * inside a step have there.
   */
  refuse: (message: string) => void;
};

/**
 * The two methods, bound to one walk.
 *
 * @internal
 */
export function createWaitMethods(options: WaitOptions): Pick<WorkflowCtx, "sleep" | "waitFor"> {
  const { runId, journal, suspend, refuse } = options;
  /**
   * Reaches so far, per NAME — a sleep by its label, a hook by its token.
   *
   * Their own maps rather than `replayRun`'s step counter, so an author's step
   * named "cooldown" and a `ctx.sleep("cooldown", …)` count independently: the
   * `!` in the key space already keeps them from aliasing, and sharing a counter
   * would make one shift the other for no reason. Two maps rather than one for
   * the same reason `workflow-replay-determinism.ts` keeps three counters —
   * inserting a sleep must shift no hook.
   */
  const sleeps = new Map<string, number>();
  const hooks = new Map<string, number>();

  /** The next occurrence of `name` in `counts`, advancing it. */
  const nextOccurrence = (counts: Map<string, number>, name: string): number => {
    const occurrence = counts.get(name) ?? 0;
    counts.set(name, occurrence + 1);
    return occurrence;
  };

  /**
   * Refuse a wait reached inside a step, or answer `undefined` at body level.
   *
   * Called BEFORE the occurrence counter advances, so a refused call leaves the
   * key space untouched and the failure names one cause rather than two — and,
   * more importantly, before the wait is CLAIMED: a claimed wait inside a step
   * parks on a promise that cannot settle and the delivery never returns.
   */
  function refuseInsideStep(method: string): Error | undefined {
    const noWait = waitInsideStep(method);
    if (!noWait) return undefined;
    refuse(noWait.message);
    return noWait;
  }

  async function sleep(
    label: string,
    until: number | Date,
    sleepOptions?: SleepOptions,
  ): Promise<void> {
    const noWait = refuseInsideStep("ctx.sleep");
    if (noWait) throw noWait;
    const occurrence = nextOccurrence(sleeps, label);
    const slot = suspend.enter();
    try {
      const record = await journal.claimSleep(
        runId,
        `sleep!${label}#${occurrence}`,
        wakeAtFrom(until),
        sleepOptions?.correlationId,
      );
      // Woken early, or the moment has passed — either way the wait is over. A
      // deadline in the past is not an error: a run resuming after a long outage
      // meets that case legitimately, and so does every replay after the wake.
      if (record.woken || Date.now() >= record.wakeAt) return;
      // PARKED, never thrown. The body's `await` here never resumes, so no
      // `catch` sees a suspension and no `finally` runs on one.
      return slot.park(record.wakeAt);
    } finally {
      slot.end();
    }
  }

  /**
   * The DEADLINE half of a `waitFor({ timeoutMs })`, once the hook is open.
   *
   * Its own function because the two halves answer different questions — is
   * there an answer, versus has the window closed — and inlined they took
   * `waitFor` over Biome's cognitive-complexity ceiling.
   *
   * **It answers a DESCRIPTOR and never parks**, which is the one thing about
   * this split that is not a free move. `slot.park` hands back a promise that
   * never settles, so `return slot.park(x)` inside a `try`/`finally` is
   * load-bearing exactly as written: the expression is evaluated, the `finally`
   * runs `slot.end()` — which is what marks this engine operation quiescent and
   * lets the walk suspend — and the pending promise is returned. A helper that
   * PARKED would have to be `return`ed without `await` for that to still hold,
   * and then its own `claimSleep` would run after `slot.end()` and its park
   * would land on a slot already closed. Measured: `replayRun` never returns,
   * and `workflow-resume-equivalence.test.ts` times out rather than failing.
   */
  async function deadlineOutcome<T>(
    key: string,
    token: string,
    occurrence: number,
    timeoutMs: number,
  ): Promise<{ park: number } | { value: T | undefined }> {
    // A DEADLINE is journaled as its own sleep, sharing the hook's occurrence so
    // the two travel together. That is what makes the window immune to replay:
    // the wake time is decided the first time this wait is reached, where a
    // `Promise.race` against a fresh `ctx.sleep` would restart it on every
    // delivery and the window would never close.
    const deadline = await journal.claimSleep(
      runId,
      `hookTimeout!${token}#${occurrence}`,
      Date.now() + timeoutMs,
      undefined,
      // Not an ordinary sleep: a bare `wakeUp(runId)` cuts a SCHEDULE short and
      // must not also close an approval window. See `SleepRecord.kind`.
      "hookTimeout",
    );
    if (!(deadline.woken || Date.now() >= deadline.wakeAt)) return { park: deadline.wakeAt };
    // Closed unanswered. The hook is CLOSED before the body continues, so a
    // signal arriving a moment later cannot make the next replay read a payload
    // and take the answered branch — see `HookRecord.closed`. `undefined` rather
    // than a throw: a window closing is an outcome a body branches on.
    //
    // The close is a COMPARE-AND-SET and its answer decides the branch. A signal
    // really can land between the deadline read above and this line, and closing
    // over it was the divergence `HookRecord.closed` exists to prevent arriving
    // by the other door: this walk would time out while every later replay read
    // `delivered: true` and answered.
    if (await journal.closeHook(runId, key)) return { value: undefined };
    // Refused, so the window was ANSWERED. Re-read it — `claimHook` is
    // idempotent on the key, so this is the same read the next replay makes,
    // which is exactly the point.
    const answered = await journal.claimHook(runId, key, token);
    return { value: answered.payload as T };
  }

  async function waitFor<T>(token: string, waitOptions?: WaitForOptions): Promise<T | undefined> {
    const noWait = refuseInsideStep("ctx.waitFor");
    if (noWait) throw noWait;
    // Keyed by the TOKEN the body reached — a name it already had, so unlike
    // `ctx.sleep` this needed no new argument.
    const occurrence = nextOccurrence(hooks, token);
    const slot = suspend.enter();
    try {
      const key = `hook!${token}#${occurrence}`;
      const record = await journal.claimHook(runId, key, token);
      // Is the record this wait's own? `claimHook` is idempotent on the KEY, so
      // what comes back on a replay was written by whichever wait reached that
      // key first — and its token is the one field in the answer that says which
      // one that was. An assertion about the key SCHEME rather than about the
      // body, and unreachable while the scheme names the token; see
      // `waitTokenDiverged` for what it caught when keys were positional.
      const mismatch = waitTokenDiverged(key, token, record.token);
      if (mismatch) {
        refuse(mismatch.message);
        throw mismatch;
      }
      // The FIRST payload, every replay. `claimHook` is idempotent on the key,
      // so a re-walk reads what was delivered rather than registering a second
      // wait.
      if (record.delivered) return record.payload as T;
      // No deadline: nothing but a signal ends this, so the wait contributes no
      // wake time — `undefined` is what tells `earliestDeadline` to skip it.
      if (waitOptions === undefined) return slot.park(undefined);
      // AWAITED inside the slot, so the deadline's own journal write is held the
      // way every other engine operation is; the park below is what must stay in
      // this `try`. See `deadlineOutcome`.
      const outcome = await deadlineOutcome<T>(key, token, occurrence, waitOptions.timeoutMs);
      return "park" in outcome ? slot.park(outcome.park) : outcome.value;
    } finally {
      slot.end();
    }
  }

  // Cast-free by construction: `sleep` takes a plain `string` label where
  // `WorkflowCtx.sleep` constrains it to `Literal<Label>`, and a wider parameter
  // is assignable to a narrower one. `waitFor`'s overloads resolve the same way.
  return { sleep, waitFor };
}
