// Copyright 2026 the AAI authors. MIT license.
/**
 * Barge-in for the AssemblyAI streaming TTS adapter: the `Cancel` frame, and
 * the window in which the abandoned turn's trailing frames must be ignored.
 *
 * Split out for the same reason `assemblyai-segment.ts` and
 * `assemblyai-turn.ts` are — the adapter owns socket and turn lifecycle, this
 * owns one rule.
 *
 * **A mid-turn cancel sends `Cancel` and KEEPS the socket.** The adapter's
 * module doc asserted the opposite for a long time — "the protocol has no
 * discard/cancel frame, so a mid-turn cancel drops the whole connection and
 * reconnects" — which was never verified and is wrong; `Cancel` is in the
 * vocabulary the service enumerates when handed an unknown frame type. So
 * every barge-in was tearing down and rebuilding a WebSocket, paying a
 * reconnect at the one moment in a call when the caller is actively talking.
 *
 * Both properties the reconnect existed for are things `Cancel` does, measured
 * against production 2026-08-18:
 *
 * - **It discards text Generate'd but never Flush'ed**, which would otherwise
 *   be spliced into the next turn's synthesis. `Generate(~40s of text)` ->
 *   `Cancel` -> `Generate("Here is the second turn.")` + `Flush` synthesized
 *   1600 ms of audio, against a 1520 ms baseline for that sentence alone.
 * - **It aborts synthesis already in progress.** Cancelling 120 ms into a
 *   ~40 s reply delivered ~2.5 s of audio in total, and the turn was answered
 *   with `Cancelled` and no `FlushDone` at all.
 *
 * **`Cancelled` is the BOUNDARY, and that is what this module replaces the
 * socket drop with.** Dropping the connection made the abandoned turn's late
 * frames unobservable for free. On a socket that survives, ~0.3 s of
 * already-in-flight audio still arrives after the `Cancel` goes out, and a
 * stale `is_final`/`FlushDone` would retire one of the NEXT turn's outstanding
 * flushes — the hazard `assemblyai-turn.ts` describes. The service answers in
 * order on one socket, so its `Cancelled` frame is exactly the line between
 * the two turns: everything before it belongs to the turn the caller barged in
 * on. Verified end-to-end against production, the adapter leaks **0 bytes**
 * after a cancel where the raw socket delivers ~0.3 s.
 *
 * `Error` is deliberately NOT suppressed in that window — it describes the
 * SOCKET, not the abandoned turn, and swallowing one would mute the session
 * silently. That filtering is applied by the adapter's frame handler; this
 * module owns only the window.
 *
 * **The deadline is why the reconnect survives.** A window that never lifts is
 * a session that never plays audio again — the same silent-mute failure the
 * reconnect path's own deadline exists to prevent, reached by a new route — so
 * a `Cancelled` that does not arrive within {@link TTS_CANCEL_ACK_TIMEOUT_MS}
 * falls back to dropping the socket. Measured, that acknowledgement lands
 * within a millisecond; the deadline is a liveness bound on a misbehaving
 * socket, not a tuning knob.
 */

import { TTS_CANCEL_ACK_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";

/** The suppression window between a `Cancel` and its `Cancelled`. */
export interface CancelBarrier {
  /** Is a cancelled turn's audio still arriving? */
  abandoned(): boolean;
  /** The service acknowledged one `Cancel`. */
  onCancelled(): void;
  /** A `Cancel` went out: shut the window and arm the acknowledgement deadline. */
  arm(): void;
  /** Reopen the window — nothing from a cancelled turn can be in flight now. */
  reset(): void;
}

/**
 * Create a {@link CancelBarrier}. `onAckTimeout` fires when an armed `Cancel`
 * goes unacknowledged past the deadline; the caller supplies the recovery (and
 * checks its session is still open — this module does not know about one).
 */
export function createCancelBarrier(onAckTimeout: () => void): CancelBarrier {
  // A COUNT, not a flag: a second barge-in can land while the first is still
  // unacknowledged, and the window has to stay shut until the last is answered.
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    abandoned: () => pending > 0,

    onCancelled(): void {
      if (pending > 0) pending -= 1;
      if (pending === 0) clearTimer();
    },

    arm(): void {
      pending += 1;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        if (pending === 0) return;
        onAckTimeout();
      }, TTS_CANCEL_ACK_TIMEOUT_MS);
      timer.unref?.();
    },

    reset(): void {
      pending = 0;
      clearTimer();
    },
  };
}
