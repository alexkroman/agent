// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn-invalidation guards for the pipeline transport.
 *
 * `chainTurn` serializes turns behind a promise chain, so a turn can sit
 * *queued* behind the active one — and by the time it runs, the session may
 * have been reset, stopped, or client-cancelled. Likewise an aborted turn's
 * `persistInterruptedTurn` runs asynchronously after the abort, by which
 * point `reset()` may already have cleared the history it would write into.
 * Promise continuations can't be cancelled the way timers can, so both are
 * guarded by epochs: captured when the work is created, re-checked when it
 * runs, and bumped by whatever invalidates it.
 *
 * Two epochs, not one, because the invalidation scopes differ: a client
 * `cancelReply()` means "stop responding" (queued turns are stale) but the
 * conversation continues — the aborted reply's `[interrupted]` text must
 * still be recorded. A `reset()`/`stop()`/terminate discards or ends the
 * conversation itself, so pending persistence is stale too.
 */

import { createEpoch } from "../../sdk/epoch.ts";

export interface TurnGate {
  /** Epoch to capture when queueing a turn (chainTurn). */
  queueEpoch(): number;
  /** Epoch to capture when a turn starts (guards its deferred persistence). */
  historyEpoch(): number;
  /** May a turn queued at `epoch` still run? */
  queueCurrent(epoch: number): boolean;
  /** May a turn started at `epoch` still write history / emit its interrupted transcript? */
  historyCurrent(epoch: number): boolean;
  /** "Stop responding" (client cancelReply): strand queued turns only. */
  invalidateQueued(): void;
  /** The conversation is discarded (reset) or over (stop/terminate): strand everything. */
  invalidateAll(): void;
}

/** Create a {@link TurnGate}. */
export function createTurnGate(): TurnGate {
  const queue = createEpoch();
  const history = createEpoch();
  return {
    queueEpoch: queue.current,
    historyEpoch: history.current,
    queueCurrent: queue.isCurrent,
    historyCurrent: history.isCurrent,
    invalidateQueued: queue.bump,
    invalidateAll(): void {
      queue.bump();
      history.bump();
    },
  };
}
