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
 * Pacing introduces three ordering rules that did not exist when every frame
 * went out immediately, all enforced here:
 *
 * - **`audio_done` may not overtake queued audio.** It is a turn boundary; the
 *   client's worklet takes it as "this is all there is" and plays out only
 *   what it holds, so an early `audio_done` truncates the reply.
 * - **Neither may any other end-of-reply frame** ({@link
 *   PacedAudioSink.pushAfterAudio}). `reply_done` says the turn is over while
 *   seconds of its audio are still held here, so a client that closes the
 *   turn's books on it — attributing later audio to the *next* reply — loses
 *   most of the reply. That is not hypothetical: the tau2 voice harness pairs
 *   each reply's transcript with its audio by exactly that boundary, so every
 *   agent turn reached the simulated caller as speech carrying no words.
 * - **A barge-in must discard held audio** ({@link PacedAudioSink.clear}).
 *   The client drops its own buffer on the cancel event, so anything still
 *   held here would arrive afterwards and play as an orphan fragment. Queued
 *   frames go with it: `cancelled` is itself the turn boundary, and a
 *   `reply_done` arriving after it would contradict the event the client
 *   already acted on.
 */
import { CLIENT_AUDIO_LEAD_MS, PACER_BURST_MS } from "@alexkroman1/aai/host-internal";

/** PCM16 — the wire format for client audio in both directions. */
const BYTES_PER_SAMPLE = 2;

/**
 * The lead for a client that is not a real-time player: no pacing at all, every
 * frame relayed as it arrives.
 *
 * Pacing exists because a browser plays a reply at exactly one second per
 * second, so anything past a small lead is queue the server cannot see into. A
 * programmatic client keeps its own clock and its own buffer — a telephony
 * bridge, a test, a simulation harness whose timeline advances per processed
 * tick rather than per wall-clock second. Metering audio to the wall clock for
 * one of those does not protect it; it starves it, and it does so invisibly,
 * since the frames all arrive eventually. The socket backpressure guard in
 * `ws-handler.ts` still covers a genuinely stalled link.
 */
export const UNPACED_AUDIO_LEAD_MS = Number.POSITIVE_INFINITY;

/** Options for {@link createAudioPacer}. */
export type AudioPacerOptions = {
  /** Deliver one audio frame to the client. */
  sendAudio: (chunk: Uint8Array) => void;
  /** Sample rate of the relayed PCM16, used to convert bytes to duration. */
  sampleRate: number;
  /**
   * Lead ceiling; defaults to {@link CLIENT_AUDIO_LEAD_MS}.
   * {@link UNPACED_AUDIO_LEAD_MS} disables pacing while keeping the ordering
   * rules (a queued frame still follows the audio pushed before it).
   */
  leadMs?: number;
};

/** A paced audio channel. See the module doc for the ordering rules. */
export type PacedAudioSink = {
  /** Queue one audio frame, sending now if the lead allows. */
  push(chunk: Uint8Array): void;
  /**
   * Queue a non-audio send behind any held audio — for a frame that closes out
   * the reply the held audio belongs to (see the module doc). Everything else
   * (`reply.cancelled`, `error.reported`, a committed user transcript, a relayed
   * `tool.called`) must go out
   * immediately; delaying those by the lead would delay the conversation.
   */
  pushAfterAudio(send: () => void): void;
  /** Drop held audio (barge-in), flush queued frames, and reset the lead. */
  clear(): void;
  /** Drop everything held and refuse further sends (socket closing). */
  stop(): void;
};

type QueueItem =
  | { kind: "audio"; chunk: Uint8Array; durationMs: number }
  | { kind: "frame"; send: () => void };

export function createAudioPacer(opts: AudioPacerOptions): PacedAudioSink {
  const { sendAudio, sampleRate } = opts;
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
      if (item.kind === "frame") {
        queue.shift();
        item.send();
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

  function enqueue(item: QueueItem): void {
    if (stopped) return;
    queue.push(item);
    // A pending timer already owns the drain; pushing must not jump the
    // queue, and FIFO order is what keeps the reply intact.
    if (timer === null) drain();
  }

  return {
    push(chunk) {
      if (chunk.byteLength === 0) return;
      enqueue({ kind: "audio", chunk, durationMs: chunk.byteLength * msPerByte });
    },

    pushAfterAudio(send) {
      enqueue({ kind: "frame", send });
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
