// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn serializer for the pipeline transport.
 *
 * Turns run one at a time behind a promise chain, so a turn can sit *queued*
 * behind the active one — and by the time it runs, the session may have been
 * reset, stopped, or client-cancelled. Promise continuations can't be
 * cancelled the way timers can, so queued turns are guarded by an epoch:
 * captured at `chain()`, re-checked when the turn's slot in the chain comes
 * up, and bumped by `invalidate()`. A stranded turn never starts, so no
 * billed LLM call is made on its behalf.
 *
 * This module used to also carry a second epoch guarding an aborted turn's
 * deferred history persistence; that job moved to `TaskScope`
 * (../task-scope.ts) — the persistence is now an interrupt finalizer that
 * invalidation paths either await (`cancelReply`) or discard
 * (`reset`/`stop`/terminate) instead of racing.
 */

export interface TurnQueue {
  /**
   * Queue a turn behind whatever is already chained. Stranded (never
   * started) if `invalidate()` lands or the session terminates before its
   * slot comes up. Callers attach their own `.catch` inside `start`; one
   * that slips through costs that turn, not the serializer.
   */
  chain(start: () => Promise<void>): void;
  /** Strand queued turns (cancelReply / reset / stop / terminate). */
  invalidate(): void;
  /** Resolves when everything currently chained has settled (for stop()). */
  settled(): Promise<void>;
}

/** Create a {@link TurnQueue}. */
export function createTurnQueue(isTerminated: () => boolean): TurnQueue {
  let epoch = 0;
  let tail: Promise<void> | null = null;
  return {
    chain(start): void {
      const captured = epoch;
      // Chain past a rejected predecessor — a rejected tail would mean no
      // turn ever runs again.
      tail = (tail ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => (isTerminated() || captured !== epoch ? undefined : start()));
    },
    invalidate(): void {
      epoch += 1;
    },
    settled(): Promise<void> {
      return (tail ?? Promise.resolve()).catch(() => undefined);
    },
  };
}
