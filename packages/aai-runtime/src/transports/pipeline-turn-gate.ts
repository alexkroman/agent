// Copyright 2026 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai/utils";
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

import { createEpoch } from "@alexkroman1/aai/internal";

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

/** Serializes turns behind one promise chain — see {@link createTurnChain}. */
export interface TurnChain {
  /** Enqueue `start` behind the active turn (if any). */
  chain(start: () => Promise<void>): void;
  /** Await the tail of the chain, swallowing rejections. `stop()`'s drain. */
  settled(): Promise<void>;
}

/**
 * The turn serializer this module's doc opens by describing — a single promise
 * chain plus the {@link TurnGate} epoch check that strands a queued turn the
 * session has moved past.
 */
export function createTurnChain(deps: {
  gate: TurnGate;
  /** The transport terminated: nothing queued may still start. */
  isTerminated(): boolean;
}): TurnChain {
  let turnPromise: Promise<void> | null = null;
  return {
    chain(start: () => Promise<void>): void {
      // Captured at enqueue, re-checked at run: a reset/stop/cancelReply landing
      // while this turn waits behind an active one strands it — otherwise it
      // would run a full billed streamText turn after the session moved on.
      const epoch = deps.gate.queueEpoch();
      // Chain past a rejected predecessor: every call site attaches its own
      // .catch, but one that slips through must cost that turn, not wedge the
      // serializer (a rejected turnPromise would mean no turn ever runs again).
      turnPromise = (turnPromise ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => (deps.isTerminated() || !deps.gate.queueCurrent(epoch) ? undefined : start()));
    },
    async settled(): Promise<void> {
      if (turnPromise !== null) await turnPromise.catch(() => undefined);
    },
  };
}

/**
 * Build the transport's turn-crash handler factory. Throw-safe: the logger is
 * caller-injectable, and a throw from a `.catch` handler would reject the
 * chained turn promise anyway — exactly what the handler exists to prevent.
 */
export function turnCrashLogger(
  log: { error(msg: string, meta?: Record<string, unknown>): void },
  sid: string,
): (what: string) => (err: unknown) => void {
  return (what) => (err) => {
    try {
      log.error(what, { error: errorMessage(err), sid });
    } catch {
      // A throwing logger must not poison the turn chain.
    }
  };
}
