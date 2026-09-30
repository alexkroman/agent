// Copyright 2026 the AAI authors. MIT license.
/**
 * The microphone's way onto the wire — backpressure, and the caller's MUTE.
 *
 * Split out of `session-core.ts` at the source-length cap, along the seam the
 * two share: both decide what a captured frame becomes on the socket, and
 * nothing else in the core reads either.
 *
 * ## A muted frame is SILENCE, not an absent frame
 *
 * `setMicMuted(true)` keeps sending every frame the capture worklet produces,
 * at the same length and cadence, zero-filled. Sending nothing would look
 * cheaper and is wrong on three counts:
 *
 * - **Endpointing.** Hold-to-talk over an agent with AUTOMATIC turn detection
 *   is mute-until-pressed, unmute, speak, mute on release. The transcriber
 *   ends the turn on a stretch of silence; a stream that simply stops gives it
 *   no silence to measure, so the last utterance is answered late or not at
 *   all.
 * - **The stream clock.** The transcriber timestamps by samples received. The
 *   runtime's own push-to-talk silences the mic the same way, for the same
 *   reason (`pipeline-transport-commands.ts`, "sent as SILENCE rather than
 *   withheld").
 * - **Idle.** Nothing is gained on the server side by going quiet: the session
 *   idle deadline deliberately does not count user audio (`ServerSession.onAudio`
 *   in the runtime), so a muted caller is retired exactly as a silent one is —
 *   while a provider that closes a socket fed no audio at all would see a gap.
 *
 * ## It is UI state, not connection state
 *
 * The flag lives on the snapshot (`micMuted`) and nothing that tears a
 * connection down touches it — not a reconnect, a resume, `disconnect()`,
 * `reset()` or `end()` — and it can be set before the first `connect()`, so a
 * UI can open a typed-only session already muted. Muting sends no command and
 * interrupts nothing; it only changes what the next frame carries.
 *
 * It sits AFTER the capture worklet, so the worklet's own digital-silence
 * probe (`onMicSilent`, `MIC_SILENCE_PROBE_MS` in `audio.ts`) still measures
 * the real input: zeros this module writes can never read as a dead mic.
 *
 * @module
 */

import { WS_OPEN } from "@alexkroman1/aai/internal";
import type { ConnState, SessionSnapshot } from "./session-core-types.ts";
import { MIC_SEND_MAX_BUFFERED_BYTES } from "./types.ts";

/** What the mic sender needs from the session around it. @internal */
export type MicDeps = {
  conn: ConnState;
  snapshot: () => SessionSnapshot;
  updateState: (partial: Partial<SessionSnapshot>) => void;
};

/** The mic's wire half — see this module's doc. @internal */
export type MicSender = {
  /** Send one captured PCM16 frame — as silence while muted. */
  sendAudio(bytes: ArrayBuffer): void;
  /**
   * Send the pre-connect burst (`session-core-preconnect.ts`) — muted like
   * any frame, but past the backpressure drop: those frames are the audio the
   * burst exists to deliver, bounded by `PRE_CONNECT_MAX_SECONDS`, and a
   * dropped one would splice the caller's opener mid-word.
   */
  sendBuffered(chunks: ArrayBuffer[]): void;
  /** Mute or unmute the caller. Idempotent, local, and connection-independent. */
  setMicMuted(muted: boolean): void;
};

/** Build one session's mic sender. @internal */
export function createMicSender(deps: MicDeps): MicSender {
  // One zero frame, reused while its length holds: the worklet's batch size is
  // fixed, so a muted stretch allocates once rather than once per frame.
  // `send` copies the bytes out, so sharing the buffer across sends is safe.
  let silence = new ArrayBuffer(0);
  const silent = (length: number): ArrayBuffer => {
    if (silence.byteLength !== length) silence = new ArrayBuffer(length);
    return silence;
  };

  return {
    sendAudio(bytes: ArrayBuffer): void {
      const ws = deps.conn.ws;
      if (ws?.readyState !== WS_OPEN) return;
      // Backpressure: if the socket's send queue is backed up (slow network),
      // drop this frame instead of queueing. Queued mic audio only adds latency
      // and flushes stale speech into STT once the connection recovers.
      if (ws.bufferedAmount > MIC_SEND_MAX_BUFFERED_BYTES) return;
      ws.send(deps.snapshot().micMuted ? silent(bytes.byteLength) : bytes);
    },
    sendBuffered(chunks: ArrayBuffer[]): void {
      const ws = deps.conn.ws;
      if (ws?.readyState !== WS_OPEN) return;
      const muted = deps.snapshot().micMuted;
      for (const bytes of chunks) ws.send(muted ? silent(bytes.byteLength) : bytes);
    },
    setMicMuted(muted: boolean): void {
      deps.updateState({ micMuted: muted });
    },
  };
}
