// Copyright 2026 the AAI authors. MIT license.
/**
 * Serialize-and-coalesce for repeatable async work.
 *
 * The recurring shape: some operation ("sync the workspace", "typecheck the
 * tree") reads the *latest* state when it runs, is expensive enough that
 * overlapping runs are wrong (two concurrent walks interleave into a torn
 * result) — and, crucially, a run that started BEFORE a trigger cannot vouch
 * for that trigger's change, so "one is already running" is not "this
 * trigger is covered". The fix both call sites hand-rolled: at most one run
 * in flight; a trigger arriving mid-run marks ONE trailing re-run, started
 * only after the current run settles; any number of mid-run triggers
 * coalesce into that single trailing run. Coalescing beats queueing because
 * the run reads current state — N queued runs would do the trailing run's
 * work N times, and a long burst would build an unbounded backlog.
 *
 * This module is that pattern with a name, like `createEpoch` and
 * `createOwnedMap` (see sdk/epoch.ts for the rationale of reifying these).
 */

/**
 * Handle returned by {@link createCoalescingRunner}.
 *
 * @internal
 */
export interface CoalescingRunner<T> {
  /**
   * Request a run whose result reflects state as of this call or later.
   *
   * - Idle: starts `run()` immediately and returns its promise.
   * - A run in flight: returns the shared trailing promise — one follow-up
   *   run started after the current run settles (success or failure). Every
   *   trigger arriving during the same in-flight run gets the same promise.
   *
   * The returned promise settles with that run's outcome; a rejection
   * reaches only the callers awaiting that run and never wedges the runner —
   * the next `trigger()` starts fresh. Fire-and-forget callers must attach
   * their own `.catch()`.
   */
  trigger(): Promise<T>;
}

/**
 * Create a {@link CoalescingRunner} over `run`.
 *
 * `run` takes no arguments by design: coalescing collapses N triggers into
 * one run, so per-trigger payloads would be silently dropped — the run
 * closes over (or re-reads) the latest state instead, which is exactly what
 * makes the collapse safe. A synchronous throw from `run` is normalized into
 * a rejection of the returned promise.
 *
 * @internal
 */
export function createCoalescingRunner<T>(run: () => Promise<T> | T): CoalescingRunner<T> {
  let inFlight: Promise<T> | null = null;
  let trailing: Promise<T> | null = null;

  const start = (): Promise<T> => {
    const current = Promise.resolve()
      .then(run)
      .finally(() => {
        // Identity-checked, not unconditional: by the time a run settles the
        // slot may already hold a successor (the trailing run chains off this
        // promise, and `finally` ordering is what guarantees it sees null —
        // but a defensive clear of someone else's run would break that).
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  const trigger = (): Promise<T> => {
    if (inFlight === null) return start();
    if (trailing === null) {
      // Wait out the current run whatever its outcome — its failure belongs
      // to its own callers, not to the coalesced trailing ones — then start
      // the follow-up. `finally` on `inFlight` has run by then, so the
      // recursive trigger() takes the idle path and starts a fresh run.
      trailing = inFlight
        .catch(() => undefined)
        .then(() => {
          trailing = null;
          return trigger();
        });
    }
    return trailing;
  };

  return { trigger };
}
