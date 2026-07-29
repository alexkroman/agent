// Copyright 2026 the AAI authors. MIT license.
/**
 * Task-scoped lifetime primitive — two structured-concurrency guarantees
 * that the pipeline transport's race-condition history (#685) shows are
 * load-bearing, without adopting a framework:
 *
 * 1. **Awaitable interrupt.** `interrupt()` aborts the scope's signal and
 *    resolves only after the scope's work has settled and its interrupt
 *    finalizers have run. A caller that must order follow-up work after an
 *    aborted task's async wind-down can await it; an invalidation path that
 *    wants the wind-down *not* to happen (`reset()` discarding an aborted
 *    turn's history persistence) passes `discardFinalizers` instead of
 *    racing it. This replaces the epoch pattern: capture-then-recheck
 *    becomes own-then-discard.
 *
 * 2. **Scope-owned timers.** `timer()` returns a {@link RestartableTimer}
 *    the scope clears the moment it is interrupted and again when it
 *    settles. A timer that must die with its turn (the dead-air cover) gets
 *    that for free instead of per-call-site abort-listener bookkeeping.
 *
 * A scope may have a parent signal (the session): the scope aborts with it,
 * and the link is removed at settle so per-turn scopes don't accumulate
 * listeners on the session-lifetime signal (previously `linkAbort`).
 */

import { createRestartableTimer, type RestartableTimer } from "./_timer.ts";

/** A timer for a scope that is already over — never arms, never fires. */
const INERT_TIMER: RestartableTimer = {
  arm(): void {
    // Scope is settled/interrupted: nothing may fire on its behalf.
  },
  clear(): void {
    // Nothing armed.
  },
  pending: () => false,
};

export interface TaskScope {
  /** Aborts when the scope is interrupted (or its parent aborts). */
  readonly signal: AbortSignal;
  /**
   * Register a finalizer that runs iff the scope was interrupted, after its
   * `run()` work settles and before `interrupt()` resolves. Finalizers run
   * in registration order; a throw is contained and logged. Never runs when
   * the work completes without interruption, or when the interrupt
   * discarded finalizers.
   */
  onInterrupt(finalizer: () => void | Promise<void>): void;
  /**
   * A {@link RestartableTimer} owned by the scope: cleared immediately when
   * the scope's signal aborts and again at settle. Returns an inert timer if
   * the scope is already over.
   */
  timer(onElapsed: () => void): RestartableTimer;
  /**
   * Run the scope's work (once). The scope settles when `fn` — and, on an
   * interrupted scope, its finalizers — complete; `fn`'s result/rejection
   * passes through unchanged.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Abort the scope (synchronously, before returning) and resolve once it
   * has settled — work wound down, finalizers done. `discardFinalizers`
   * drops pending interrupt finalizers instead of running them; it also
   * applies to a scope already interrupted whose finalizers have not
   * started. Idempotent.
   */
  interrupt(opts?: { discardFinalizers?: boolean }): Promise<void>;
}

/** Create a {@link TaskScope}, optionally linked to a parent signal. */
export function createTaskScope(opts?: { parent?: AbortSignal | undefined }): TaskScope {
  const ctl = new AbortController();
  const finalizers: Array<() => void | Promise<void>> = [];
  const timers: RestartableTimer[] = [];
  let discarded = false;
  let settled = false;
  let hasRun = false;
  const settledDeferred = Promise.withResolvers<void>();

  function clearTimers(): void {
    for (const t of timers) t.clear();
  }

  const parent = opts?.parent;
  const onParentAbort = (): void => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  ctl.signal.addEventListener("abort", clearTimers, { once: true });

  async function runFinalizers(): Promise<void> {
    // Drain one at a time so a discard landing mid-run (interrupt →
    // finalizers running → reset) still stops the remainder, and contain
    // throws — a failing finalizer must not skip the rest or reject run().
    while (!discarded) {
      const finalizer = finalizers.shift();
      if (finalizer === undefined) return;
      try {
        await finalizer();
      } catch (err) {
        console.error("[task-scope] interrupt finalizer threw", err);
      }
    }
  }

  function settle(): void {
    if (settled) return;
    settled = true;
    parent?.removeEventListener("abort", onParentAbort);
    clearTimers();
    timers.length = 0;
    finalizers.length = 0;
    settledDeferred.resolve();
  }

  return {
    signal: ctl.signal,

    onInterrupt(finalizer): void {
      if (settled) return;
      finalizers.push(finalizer);
    },

    timer(onElapsed): RestartableTimer {
      if (settled || ctl.signal.aborted) return INERT_TIMER;
      const t = createRestartableTimer(onElapsed);
      timers.push(t);
      return t;
    },

    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (hasRun) throw new Error("TaskScope.run() may only be called once");
      hasRun = true;
      try {
        return await fn();
      } finally {
        if (ctl.signal.aborted && !discarded) await runFinalizers();
        settle();
      }
    },

    interrupt(o): Promise<void> {
      if (o?.discardFinalizers) discarded = true;
      ctl.abort();
      // A scope whose work never started has nothing to wind down.
      if (!hasRun) settle();
      return settled ? Promise.resolve() : settledDeferred.promise;
    },
  };
}
