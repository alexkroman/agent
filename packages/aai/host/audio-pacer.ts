// Copyright 2026 the AAI authors. MIT license.
/**
 * Bounded-lead pacer for TTS audio on its way to a client.
 *
 * A TTS provider emits a reply far faster than it can be spoken, and relaying
 * each frame the instant it arrives pushes the whole reply into the client
 * socket at once. On a healthy link that is harmless; on a slow one it is a
 * queue of seconds that the server has no view into, growing until the
 * `MAX_CLIENT_WS_BUFFERED_BYTES` guard kills the connection.
 *
 * So audio flows freely until {@link CLIENT_AUDIO_LEAD_MS} of it is in flight,
 * and after that it is released on a clock. The lead is deliberately larger
 * than the client's jitter target: the client needs to be able to build a
 * cushion, so pacing at exactly real time would trade one failure mode for
 * another.
 *
 * Pacing introduces two ordering rules that did not exist when every frame
 * went out immediately, both enforced here:
 *
 * - **`audio_done` may not overtake queued audio.** It is a turn boundary; the
 *   client's worklet takes it as "this is all there is" and plays out only
 *   what it holds, so an early `audio_done` truncates the reply.
 * - **A barge-in must discard held audio** ({@link PacedAudioSink.clear}).
 *   The client drops its own buffer on the cancel event, so anything still
 *   held here would arrive afterwards and play as an orphan fragment.
 */
import { CLIENT_AUDIO_LEAD_MS, PACER_BURST_MS } from "../sdk/constants.ts";

/** PCM16 — the wire format for client audio in both directions. */
const BYTES_PER_SAMPLE = 2;

/** Options for {@link createAudioPacer}. */
export type AudioPacerOptions = {
  /** Deliver one audio frame to the client. */
  sendAudio: (chunk: Uint8Array) => void;
  /** Deliver the turn's `audio_done` frame. */
  sendDone: () => void;
  /** Sample rate of the relayed PCM16, used to convert bytes to duration. */
  sampleRate: number;
  /** Lead ceiling; defaults to {@link CLIENT_AUDIO_LEAD_MS}. */
  leadMs?: number;
};

/** A paced audio channel. See the module doc for the ordering rules. */
export type PacedAudioSink = {
  /** Queue one audio frame, sending now if the lead allows. */
  push(chunk: Uint8Array): void;
  /** Queue the turn's `audio_done`, ordered behind any held audio. */
  pushDone(): void;
  /** Drop everything held (barge-in) and reset the lead. */
  clear(): void;
  /** Drop everything held and refuse further sends (socket closing). */
  stop(): void;
};

type QueueItem = { kind: "audio"; chunk: Uint8Array; durationMs: number } | { kind: "done" };

export function createAudioPacer(opts: AudioPacerOptions): PacedAudioSink {
  const { sendAudio, sendDone, sampleRate } = opts;
  const leadMs = opts.leadMs ?? CLIENT_AUDIO_LEAD_MS;
  const msPerByte = 1000 / (sampleRate * BYTES_PER_SAMPLE);

  const queue: QueueItem[] = [];
  /**
   * Wall-clock time at which everything sent so far would finish playing.
   * The lead is this minus now — a virtual playout clock rather than a byte
   * count, so it stays correct across turns of any length.
   */
  let playoutMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const leadAt = (now: number): number => Math.max(0, playoutMs - now);

  // Wake only after the lead has drained PACER_BURST_MS below the ceiling and
  // release that whole span per fire, rather than one timer callback per audio
  // frame — at typical TTS frame sizes that is ~50 wakeups/second per speaking
  // session for smoothness the client's jitter buffer doesn't need. Clamped so
  // a small custom lead still leaves the client half its cushion.
  const burstMs = Math.min(PACER_BURST_MS, leadMs / 2);

  function schedule(now: number): void {
    if (timer !== null) return;
    // Wake when the lead has drained a burst below the ceiling. At least 1ms
    // so a rounding artifact cannot schedule a zero-delay loop.
    const waitMs = Math.max(1, Math.ceil(leadAt(now) - (leadMs - burstMs)));
    timer = setTimeout(drain, waitMs);
    timer.unref?.();
  }

  function drain(): void {
    timer = null;
    if (stopped) return;
    while (queue.length > 0) {
      const item = queue[0];
      if (item === undefined) return;
      if (item.kind === "done") {
        queue.shift();
        sendDone();
        continue;
      }
      const now = Date.now();
      if (leadAt(now) > leadMs) {
        schedule(now);
        return;
      }
      queue.shift();
      sendAudio(item.chunk);
      // A frame is atomic, so crossing the ceiling by one frame is expected;
      // max() re-bases the clock when the previous turn finished long ago.
      playoutMs = Math.max(now, playoutMs) + item.durationMs;
    }
  }

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  // Shared by clear() and stop(): drop everything held and reset the lead.
  // The turn is over on both ends — audio already sent was discarded
  // client-side, so none of it is still playing.
  function reset(): void {
    queue.length = 0;
    cancelTimer();
    playoutMs = 0;
  }

  return {
    push(chunk) {
      if (stopped || chunk.byteLength === 0) return;
      queue.push({ kind: "audio", chunk, durationMs: chunk.byteLength * msPerByte });
      // A pending timer already owns the drain; pushing must not jump the
      // queue, and FIFO order is what keeps the reply intact.
      if (timer === null) drain();
    },

    pushDone() {
      if (stopped) return;
      queue.push({ kind: "done" });
      if (timer === null) drain();
    },

    clear() {
      reset();
    },

    stop() {
      stopped = true;
      reset();
    },
  };
}
