// Copyright 2026 the AAI authors. MIT license.
/**
 * Client-audio budgets: mic capture batching, the playback jitter buffer and
 * its concealment, the server's pacing lead, and the client-side send
 * backpressure caps. Split out of `constants.ts` (which re-exports them, so
 * `@alexkroman1/aai` stays the one import path) purely to keep that module
 * under the file-length cap.
 */

/**
 * Microphone buffer duration in seconds before the client sends audio to the server.
 *
 * @internal
 */
export const MIC_BUFFER_SECONDS = 0.1;

/**
 * Window the capture worklet watches, once per session, to decide the
 * microphone is dead. A device muted at the OS level or an input that is not
 * really a microphone delivers digital silence, which is otherwise
 * indistinguishable from a user who has not spoken — the session looks healthy
 * and simply never responds.
 *
 * Exact zeros are the signal (a live mic in a quiet room still carries a noise
 * floor), and the probe disarms on the first nonzero sample, so it costs
 * nothing after the first second and cannot fire mid-session.
 *
 * @internal
 */
export const MIC_SILENCE_PROBE_MS = 1500;

/**
 * How much TTS audio the playback worklet buffers before a turn starts
 * speaking. This is the client's whole cushion against uneven chunk arrival,
 * so raising it trades time-to-first-audio for resilience. Tune it against the
 * concealment counters the worklet reports on each turn's `stop` (a turn with
 * `concealmentEvents: 0` never needed the cushion it was given).
 *
 * @internal
 */
export const PLAYBACK_JITTER_MS = 400;

/**
 * How far ahead of real time the server may run when relaying TTS audio to a
 * client. TTS synthesis outruns playback, so without a ceiling an entire reply
 * lands in the socket buffer the moment the provider produces it: on a slow
 * link that is a multi-second queue the server cannot see into, and the only
 * limit is the `MAX_CLIENT_WS_BUFFERED_BYTES` disconnect.
 *
 * **Must stay above {@link PLAYBACK_JITTER_MS}.** The lead is the client's only
 * source of cushion — pacing at exactly real time would leave the playback
 * worklet unable to ever fill its jitter buffer, which is the failure mode of
 * a producer-paced/consumer-unbuffered pairing.
 *
 * @internal
 */
export const CLIENT_AUDIO_LEAD_MS = 1000;

/**
 * How far the pacer lets the lead drain below {@link CLIENT_AUDIO_LEAD_MS}
 * before waking to top it up, releasing the drained span's worth of frames
 * per wakeup instead of one frame per timer fire (~50 wakeups/second per
 * speaking session at typical TTS frame sizes). **`CLIENT_AUDIO_LEAD_MS -
 * PACER_BURST_MS` must stay above {@link PLAYBACK_JITTER_MS}** — the dip is
 * cushion the client temporarily doesn't have.
 *
 * @internal
 */
export const PACER_BURST_MS = 200;

/**
 * Refill target after an underrun, deliberately lower than
 * {@link PLAYBACK_JITTER_MS}: mid-reply, waiting to rebuild the full cushion is
 * itself a hole in the speech, so the buffer trades some resilience for a
 * shorter gap. Without a refill step at all, one stall degrades the rest of the
 * turn into a fragment per render quantum.
 *
 * @internal
 */
export const PLAYBACK_REFILL_MS = 200;

/**
 * How long concealment extrapolates from already-played audio before it has
 * decayed to silence. Covering a gap with the recent signal (rather than
 * zeros) is what keeps a stall from sounding like a click; the fade keeps a
 * long stall from buzzing a looped fragment indefinitely.
 *
 * @internal
 */
export const PLAYBACK_CONCEAL_FADE_MS = 40;

/**
 * Gain at which concealment is treated as silence: the end point of the
 * {@link PLAYBACK_CONCEAL_FADE_MS} fade, and the threshold that separates
 * `silentConcealedSamples` from the concealed total.
 *
 * @internal
 */
export const PLAYBACK_CONCEAL_FLOOR = 0.001;

/**
 * How much audio the playback worklet's ring buffer holds, in seconds. The
 * buffer is allocated once per session at the context sample rate; a reply
 * longer than this keeps playing (the ring wraps), it just cannot buffer
 * further ahead. {@link PLAYBACK_DONE_MAX_WAIT_MS} is derived from it — the
 * longest legitimate drain is one full buffer.
 *
 * @internal
 */
export const PLAYBACK_BUFFER_SECONDS = 60;

/**
 * How often the client's `done()` wait re-checks that the playback
 * AudioContext is still rendering, so a mid-playback suspension (backgrounded
 * tab) settles the wait quickly instead of hanging until the hard cap.
 *
 * @internal
 */
export const PLAYBACK_DONE_POLL_MS = 1000;

/**
 * Hard cap on waiting for playback to drain: one full
 * {@link PLAYBACK_BUFFER_SECONDS} ring (the longest legitimate drain) plus
 * slack. A wait past this means the playback processor died without
 * reporting its 'stop'.
 *
 * @internal
 */
export const PLAYBACK_DONE_MAX_WAIT_MS = PLAYBACK_BUFFER_SECONDS * 1000 + 5000;

/**
 * Bounded wait for the capture worklet's 'stopped' ack after a 'stop'
 * message. The ack follows the final flush, so waiting for it keeps the tail
 * of speech from being dropped; the timeout covers a dead worklet.
 *
 * @internal
 */
export const CAPTURE_STOP_ACK_TIMEOUT_MS = 250;

/**
 * Client-side backpressure threshold for outbound mic audio. When the
 * WebSocket's `bufferedAmount` exceeds this many bytes (~2s of 16 kHz PCM16),
 * mic frames are dropped instead of queued — for live voice, stale audio
 * flushed into STT on recovery is worse than a gap. The client-side mirror
 * of the host-side buffering budgets in `constants.ts`.
 *
 * @internal
 */
export const MIC_SEND_MAX_BUFFERED_BYTES = 64 * 1024;
