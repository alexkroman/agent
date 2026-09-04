// Copyright 2026 the AAI authors. MIT license.
/**
 * Suspension is OUT OF BAND: a workflow body can neither see it nor swallow it.
 *
 * A body that must wait cannot return — the wait may be days long and the
 * process has to be free meanwhile — so the engine has to stop it somehow. The
 * obvious way is to THROW, which is what this replaced, and the whole reason it
 * was replaced is one line of JavaScript semantics: **`catch` catches
 * everything.** A body that wrapped its waits in a `try` caught the engine's own
 * signal and ran its failure path against a run that was merely waiting.
 *
 * That is not hypothetical. It shipped. `recap-workflow`'s saga wrapped its
 * whole body in a `try`/`catch` that unwound a compensation stack, so the first
 * poll that had to wait DELETED the transcript the run was waiting for,
 * journaled the deletion as successful, and re-threw — and the engine, seeing
 * its own signal come back out, recorded the run as healthily suspended. The
 * data was gone and every signal said fine.
 *
 * The defence then was two-part and both parts were advice with a detector
 * behind it: `isWorkflowSuspend` for the body's `catch` to test, and a
 * post-hoc check in `replayRun` that FAILED a run whose body had swallowed one.
 * The second half is the tell — a guard whose job is to notice that the damage
 * has already happened is a guard that could not prevent it. Both are gone.
 *
 * ## What a wait does instead
 *
 * It returns a promise that **never settles**, and signals the engine on a
 * channel the body has no reference to:
 *
 * - `ctx.sleep` / `ctx.waitFor` journal their record and then hand back
 *   {@link WalkSlot.park}'s promise. The body's `await` simply never resumes, so
 *   there is no throw for a `catch` to catch, no rejection for a `.catch()` to
 *   see, and no completion for a `finally` to run on. Every statement after the
 *   wait is unreachable, which is exactly what "the run is parked" means.
 * - {@link SuspendController.interruption} is a promise `replayRun` RACES the
 *   body against. When the walk has parked, it rejects with a value only this
 *   module holds, and {@link SuspendController.suspensionOf} recognises it by
 *   IDENTITY. The body never receives it because the body is not what awaited
 *   it.
 *
 * This is the shape Vercel's Workflow SDK arrived at (`workflow.ts`'s
 * `WorkflowSessionState` and its `interruption: PromiseWithResolvers<never>`),
 * reached here independently of its event-sourced VM: what transfers is the
 * race, not the engine under it.
 *
 * **A late rejection of the abandoned body is not an unhandled rejection.**
 * `Promise.race` subscribes to every input, so a body that rejects after the
 * race has already settled on the interruption has a handler attached and
 * nothing reaches `process.on("unhandledRejection")` — which matters here
 * because `scripts/fail-on-process-warning.mjs` makes one a hard test failure.
 * Verified before relying on it.
 *
 * ## Outstanding waits are AGGREGATED, so a race over waits composes
 *
 * A throw stopped the body at the FIRST unelapsed wait, which is why
 * `WorkflowContext.waitFor`'s deadline is a parameter and why its doc used to say a
 * `Promise.race([ctx.waitFor(t), ctx.sleep(l, ms))]` does not compose: the race
 * rejected on whichever suspended first and the body stopped before the other
 * side had been reached. With a promise that merely parks, the body walks on and
 * reaches BOTH — so the suspension has to describe both.
 *
 * It does. The suspension is deferred until the walk has QUIESCED and carries
 * `wakeAt` = **the earliest deadline among every outstanding TIMER**, or
 * `undefined` when none of them is a timer (a hook with no deadline contributes
 * nothing: it is ended by a signal, on its own delivery). `Promise.race` over a
 * week-long sleep and a one-second one therefore wakes in a second, and
 * `Promise.all` over the two wakes when the earlier one elapses, walks past it,
 * and parks again on what is left.
 *
 * ## Quiescence, and the bound on getting it early
 *
 * "The walk has quiesced" is: at least one wait is parked, and no ENGINE
 * operation is in flight — no journal call, no step body, no narration write.
 * Every one of those goes through {@link SuspendController.enter}, so the count
 * is exact rather than inferred, and a step running beside a parked sibling
 * holds the delivery open until it has journaled its answer.
 *
 * The check is deferred by one `process.nextTick`, which drains the microtask
 * queue first (Node runs the tick queue only once microtasks are exhausted) —
 * so a body that reaches a second wait through a promise chain is seen. It is
 * deliberately NOT a `setTimeout`: `vi.useFakeTimers()` would then never fire
 * it and three of this engine's own suites would hang. Both facts were measured
 * rather than assumed.
 *
 * **What remains is a body that bridges two waits with something the engine
 * cannot see** — a real timer, or I/O outside a step. Then the check fires
 * first and the suspension names only the waits reached so far. That error is
 * bounded and one-directional, which is the reason it is acceptable: a wait the
 * body has not REACHED has nothing journaled, so the next delivery reaches it
 * fresh and decides its deadline there. **No wait is ever forgotten and no wake
 * is ever lost; at worst the run wakes later than it had to.** Anything in that
 * gap is also non-deterministic at body level, which `guard-invariants` rule 30
 * already refuses in shipped source.
 *
 * @module
 */

/** What a suspension carries. The `wakeAt` contract is `ReplayOutcome`'s. */
export type Suspension = {
  /** `undefined` means a HOOK: there is no deadline, so do not schedule one. */
  readonly wakeAt: number | undefined;
};

/**
 * One engine operation's hold on the walk.
 *
 * Taken by {@link SuspendController.enter} and ended exactly once, whichever way
 * the operation finishes — which is why every caller ends it in a `finally`.
 */
export type WalkSlot = {
  /**
   * Register an outstanding wait and end this slot; the promise NEVER settles.
   *
   * Ending the slot is part of the same call deliberately: the wait has to be
   * registered BEFORE the quiescence check this can trigger, and two statements
   * that must happen in that order are worth less than one that cannot be
   * written in the wrong one.
   *
   * `Promise<never>` because it produces no value, ever — which is also what
   * makes it assignable to whatever the wait's own signature promises.
   */
  park(wakeAt: number | undefined): Promise<never>;
  /** End this slot. Idempotent, and a no-op once {@link WalkSlot.park} has. */
  end(): void;
};

/** The suspension channel for ONE walk. See the module doc. */
export type SuspendController = {
  /**
   * What `replayRun` races the body against. Rejects once, when the walk has
   * parked, and never resolves.
   */
  readonly interruption: Promise<never>;
  /**
   * Is this thrown value THIS controller's suspension?
   *
   * Identity, not a brand and not `instanceof`: the value is minted here and
   * caught in the same `replayRun` call, so there is no second module copy for
   * the comparison to cross. That is the difference from the signal this
   * replaced, which had to be branded with a `Symbol.for` precisely because it
   * travelled out through a body and back.
   */
  suspensionOf(err: unknown): Suspension | undefined;
  /**
   * Hold the walk open for one engine operation that cannot PARK.
   *
   * {@link SuspendController.enter} is what a wait takes, because a wait's hold
   * and its registration have to be one call — see {@link WalkSlot.park}.
   */
  hold<T>(op: () => Promise<T>): Promise<T>;
  /** Hold the walk open for one engine operation that may park. */
  enter(): WalkSlot;
};

export function createSuspendController(): SuspendController {
  const channel = Promise.withResolvers<never>();
  /**
   * The ONE promise every parked wait hands back.
   *
   * Nothing anywhere holds a resolver for it — the `withResolvers` bag is read
   * for its promise and dropped — so it cannot be settled by a later delivery waking
   * the journal's sleep, by a timer, or by a test advancing a fake clock. That
   * is load-bearing rather than tidy: an abandoned walk whose wait resumed
   * would re-enter the body's step bodies and double-count every effect the
   * property harnesses measure.
   */
  const parkedForever = Promise.withResolvers<never>().promise;
  /**
   * How many waits this walk has reached and not settled.
   *
   * A COUNT rather than the list of wake times it used to be. Nothing is ever
   * removed from that list — a parked wait never settles — so the only two
   * questions ever asked of it are "is anything parked" and "what is the
   * earliest deadline", and both are maintained in O(1) as a wait arrives.
   *
   * The saving is modest and worth stating honestly rather than overclaimed:
   * the scan it replaces ran at the SUSPENSION point, which is once per walk
   * (`check` short-circuits on `suspension !== undefined` afterwards), so what
   * goes is one O(waits) pass plus an array that grew with every wait a body
   * reached. What is left is a shape with nothing to re-derive.
   */
  let parked = 0;
  /**
   * The earliest TIMER deadline among outstanding waits, or `undefined`.
   *
   * A hook with no deadline contributes NOTHING rather than winning: it ends
   * when somebody signals it, which arrives as its own delivery, so it says
   * nothing about when to come back. A suspension is `undefined` only when
   * nothing outstanding is a timer.
   */
  let earliest: number | undefined;
  let inflight = 0;
  let checking = false;
  let suspension: Suspension | undefined;

  const check = (): void => {
    checking = false;
    // Something started again between the schedule and the tick — its own end
    // re-schedules, so there is nothing to do here.
    if (suspension !== undefined || inflight > 0 || parked === 0) return;
    suspension = { wakeAt: earliest };
    channel.reject(suspension);
  };

  const schedule = (): void => {
    if (checking || suspension !== undefined || inflight > 0 || parked === 0) return;
    checking = true;
    // `process.nextTick` and not a timer: it runs only once the microtask queue
    // is exhausted, so a wait reached through a promise chain is counted, and a
    // fake clock cannot strand it. See the module doc.
    process.nextTick(check);
  };

  const enter = (): WalkSlot => {
    inflight++;
    let open = true;
    const end = (): void => {
      if (!open) return;
      open = false;
      inflight--;
      schedule();
    };
    return {
      end,
      park(wakeAt) {
        parked++;
        if (wakeAt !== undefined && (earliest === undefined || wakeAt < earliest)) {
          earliest = wakeAt;
        }
        end();
        return parkedForever;
      },
    };
  };

  return {
    interruption: channel.promise,
    suspensionOf: (err) =>
      suspension !== undefined && err === suspension ? suspension : undefined,
    enter,
    async hold(op) {
      const slot = enter();
      try {
        return await op();
      } finally {
        slot.end();
      }
    },
  };
}
