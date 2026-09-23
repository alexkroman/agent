// Copyright 2026 the AAI authors. MIT license.
/**
 * The estimated client-side playback clock the heard cursor
 * (`pipeline-heard.ts`) and the barge-in floor both read.
 *
 * Split out of `pipeline-heard.ts` for the file-length cap, on the seam that
 * module's own doc already drew: the clock is SESSION-scoped (it tracks audio
 * the client is still playing out, which outlives the reply that produced it)
 * while everything left there is REPLY-scoped. Nothing here knows about text,
 * words or a reply.
 */

import { PIPELINE_PLAYBACK_GRACE_MS } from "@alexkroman1/aai/internal";

/** Estimated client-side playback clock — see {@link createPlaybackClock}. */
export type PlaybackClock = {
  /** Advance the clock by one forwarded PCM16 chunk's duration. */
  onChunk(pcm: Int16Array): void;
  /**
   * The client's own report of unplayed backlog (`playback_progress`).
   * Clamps upward only — see the implementation for why that direction is the
   * safety property and not merely a convenience.
   */
  onClientReport(bufferedMs: number): void;
  /** Restart the clock (the client just flushed its playback buffer). */
  reset(): void;
  /** True while the client may still be playing already-forwarded audio. */
  pending(): boolean;
  /** Ms until {@link pending} turns false — graced as `pending` is, so they agree. */
  playoutMs(): number;
  /**
   * Estimated ms of forwarded audio the client has not played yet. Ungraced —
   * unlike {@link pending} — because its consumer (the heard cursor) wants
   * "where did the voice stop", not "could anything still be audible".
   */
  remainingMs(): number;
};

/**
 * Track when the client is estimated to finish playing forwarded TTS audio.
 *
 * Synthesis outruns real-time playback, so a turn can finish server-side
 * while the client still holds many seconds of buffered audio; barge-in must
 * keep working through that window or "stop" lets the buffered speech play
 * out in full. Chunks queue client-side, so each forwarded chunk's duration
 * (PCM16 mono: one sample per Int16) accumulates from wherever the previous
 * chunk left off. `pending()` errs late by PIPELINE_PLAYBACK_GRACE_MS since
 * real playback starts after network latency + the client jitter buffer.
 *
 * `now` is injectable so unit tests need no fake timers.
 */
export function createPlaybackClock(sampleRateHz: number, now: () => number): PlaybackClock {
  let endsAtMs = 0;
  return {
    onChunk(pcm) {
      const chunkMs = (pcm.length / sampleRateHz) * 1000;
      endsAtMs = Math.max(endsAtMs, now()) + chunkMs;
    },
    onClientReport(bufferedMs) {
      // CLAMP UPWARD ONLY, and that is the whole safety argument for putting a
      // client-supplied number into the barge-in floor. The model above is a
      // LOWER bound — it assumes playback starts the instant a chunk is
      // forwarded and runs at exactly 1.0x, which no real client beats — so a
      // report can only ever reveal audio the host did not know was still
      // outstanding. Taking the max means a client that never reports, reports
      // late, drops a frame, or under-reports degrades to exactly the
      // open-loop estimate, and one that over-reports (or lies) can only make
      // the agent harder to interrupt, never easier: it cannot shorten the
      // window, retire audio early, or make the host believe words were heard
      // that were not.
      //
      // A downward clamp would be the useful-looking version and is the unsafe
      // one — it would let a buggy client retire a reply's tail from the heard
      // cursor, writing words into history the caller never received.
      endsAtMs = Math.max(endsAtMs, now() + bufferedMs);
    },
    reset() {
      endsAtMs = 0;
    },
    pending() {
      return now() < endsAtMs + PIPELINE_PLAYBACK_GRACE_MS;
    },
    playoutMs() {
      return endsAtMs === 0 ? 0 : Math.max(0, endsAtMs + PIPELINE_PLAYBACK_GRACE_MS - now());
    },
    remainingMs() {
      return Math.max(0, endsAtMs - now());
    },
  };
}
