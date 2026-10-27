// Copyright 2026 the AAI authors. MIT license.
/**
 * When did the caller stop talking, for the turn about to answer them?
 *
 * The commit is not that moment: endpointing silence and the STT's latency
 * sit between the caller's last word and the final, and that gap is the most
 * variable part of the wait the caller hears (tau2 retail: p50 1.4s, p90
 * 3.4s, max 10.4s). The dead-air cover anchors the turn's opening filler on
 * this instead (`DEAD_AIR_OPENING_TARGET_MS`), so the filler lands at the
 * same point in the CALLER's wait however long the commit took.
 *
 * Recorded at the commit from `SttTurnMeta.trailingSilenceMs`, and read once
 * by the turn the commit starts. Only a FRESH commit counts: a turn opened
 * well after it — a chained turn answered once the reply in flight finished —
 * follows the agent's own speech, not the caller's, and gets the fixed window.
 */

/** A turn opening later than this after its commit is not answering it directly. @internal */
export const CALLER_STOP_FRESH_MS = 1000;

/** @internal */
export interface CallerStop {
  /** A turn was committed; `trailingSilenceMs` as the STT reported it, if it did. */
  onCommit(trailingSilenceMs: number | undefined): void;
  /** Epoch ms the caller stopped, for a turn opening now — or undefined. */
  stoppedAt(): number | undefined;
}

/** @internal */
export function createCallerStop(now: () => number = Date.now): CallerStop {
  let committedAt = 0;
  let stopped: number | undefined;
  return {
    onCommit(trailingSilenceMs) {
      committedAt = now();
      stopped =
        trailingSilenceMs !== undefined && Number.isFinite(trailingSilenceMs)
          ? committedAt - Math.max(0, trailingSilenceMs)
          : undefined;
    },
    stoppedAt() {
      return now() - committedAt <= CALLER_STOP_FRESH_MS ? stopped : undefined;
    },
  };
}
