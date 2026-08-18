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
 * How far ahead of real time the server may run when relaying TTS audio to a
 * client. TTS synthesis outruns playback, so without a ceiling an entire reply
 * lands in the socket buffer the moment the provider produces it: on a slow
 * link that is a multi-second queue the server cannot see into, and the only
 * limit is the `MAX_CLIENT_WS_BUFFERED_BYTES` disconnect.
 *
 * **Must stay above {@link PLAYBACK_FILL_MS}.** The lead is the client's only
 * source of cushion — pacing at exactly real time would leave the playback
 * worklet unable to ever fill its jitter buffer, which is the failure mode of
 * a producer-paced/consumer-unbuffered pairing.
 *
 * **This number IS the client's resilience, and it is the only thing that is.**
 * Measured against a recorded reply (`aai-ui/worklets/playback-tuning.test.ts`):
 * the client's buffer sits at the lead minus half a burst mid-reply, and the
 * longest link freeze it rides out with no concealment tracks that one-for-one —
 * 820 ms at 1000/200, 914 ms at 1000/100, 1453 ms at 1500/100, 1945 ms at
 * 2000/100, the whole reply unpaced. Time-to-first-audio is IDENTICAL at every
 * one of them, so this buys resilience at no latency cost at all.
 *
 * **1500, up from 1000, and what stops it going further is bandwidth rather than
 * correctness.** Two costs scale with it, both measured on the same reply: peak
 * bytes the server has pushed but the client has not played (46 KiB at 1000,
 * 68 KiB at 1500, 93 KiB at 2000 — all far under the 4 MiB
 * `MAX_CLIENT_WS_BUFFERED_BYTES` disconnect, which is there for a genuinely slow
 * link), and audio a mid-reply barge-in has to throw away (~0.85 s of speech at
 * 1000, ~1.3 s at 1500, ~1.8 s at 2000). The second is the real one, because it
 * is paid on exactly the metered links that can least afford it, and it is why
 * this is not simply set to the unpaced behaviour that is best for playback.
 *
 * **It is NOT coupled to {@link HEARD_AUDIO_LAG_MS}, and a note here used to say
 * it was.** The playback clock's `endsAtMs` accumulates from `max(endsAtMs,
 * now())`, so it already tracks whatever lead this is set to; the heard cursor's
 * error is measured identical at 1000, 1500 and 2000. Read that constant's doc
 * before re-deriving either one from the other.
 *
 * @internal
 */
export const CLIENT_AUDIO_LEAD_MS = 1500;

/**
 * How far the pacer lets the lead drain below {@link CLIENT_AUDIO_LEAD_MS}
 * before waking to top it up, releasing the drained span's worth of frames per
 * wakeup instead of one frame per timer fire. **`CLIENT_AUDIO_LEAD_MS -
 * PACER_BURST_MS` must stay above {@link PLAYBACK_FILL_MS}** — the dip is
 * cushion the client temporarily doesn't have.
 *
 * **It is spent out of the CLIENT's resilience, one millisecond for one**, which
 * is what sets the value. Measured on a recorded reply, the longest freeze the
 * chain rides out with no concealment: 984 ms at a 50 ms burst, 914 ms at 100,
 * 820 ms at 200, 684 ms at 400 — and time-to-first-audio is unchanged at every
 * one, so the burst buys nothing back on the audio side. It was 200.
 *
 * The wakeup saving is the only thing on the other side of that trade, and it is
 * smaller than it looks: this doc used to cite "~50 wakeups/second per speaking
 * session at typical TTS frame sizes", where AssemblyAI streaming TTS delivers
 * 3840-byte frames — 80 ms of 24 kHz PCM16 each, so **~12.5 a second** unpaced.
 * At 100 ms the pacer wakes ~8.8 times a second against ~4.6 at 200: four extra
 * timer fires per second of speech, for ~94 ms more freeze the caller never
 * hears. Going to 50 buys another ~70 ms and is left on the table deliberately —
 * that is the point where the pacer is waking more often than frames arrive.
 *
 * @internal
 */
export const PACER_BURST_MS = 100;

/**
 * The playback worklet's ONE fill target: how much audio it buffers before a
 * turn starts speaking, and how much it rebuilds after an underrun before
 * resuming.
 *
 * **There used to be two, and the startup one was redundant BY CONSTRUCTION.**
 * `PLAYBACK_JITTER_MS` (400) was documented as the client's cushion against
 * uneven arrival, and it could not be: on a turn's first render the ring is
 * empty, so `avail` (0) is under one 128-sample quantum and the underrun branch
 * fires before any audio exists — arming the REFILL target. Every turn already
 * waited for this number, and the separate startup target could only ever act by
 * being LARGER, i.e. by making a turn's first wait longer than every later
 * recovery's. That is backwards from the argument this constant rests on.
 * Measured: `{jitter: 0, refill: R}` renders byte-identically to
 * `{jitter: R, refill: R}` for R of 100, 200 and 400, on a healthy link, a
 * 900 ms-jitter link and a bandwidth-starved one alike.
 *
 * Collapsing to this one target took time-to-first-audio off the top of every
 * reply — 16 ms on a typical link, 54 ms on mobile, 118 ms at 400 ms of jitter,
 * 208 ms at 900 ms — with concealment unchanged at zero in all of them.
 *
 * **The value may not go lower, and that is the measured half.** This is the
 * re-arm that keeps one stall from degrading the rest of the turn into a
 * fragment per render quantum: on a link under the PCM bitrate, 200 ms yields a
 * handful of audible pauses where 25 ms yields ~99 concealment episodes with no
 * gap long enough to read as a pause — stutter through every word, which is the
 * failure the re-arm exists to prevent. Tune against the concealment counters
 * the worklet reports on each turn's `stop`, and note a turn with
 * `concealmentEvents: 0` did not need the cushion it was given: on any link that
 * can carry 384 kbps, the cushion that actually matters is
 * {@link CLIENT_AUDIO_LEAD_MS}, not this.
 *
 * @internal
 */
export const PLAYBACK_FILL_MS = 200;

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

/**
 * How often a client reports its unplayed agent-audio backlog to the host
 * (`playback_progress`), while it holds any.
 *
 * The host clamps upward only, so this interval sets how STALE the host's view
 * may be, not how accurate: between reports the estimate decays toward the
 * open-loop model it replaces. 500 ms is comfortably under
 * `PLAYBACK_JITTER_MS` plus a network hop — the scale at which the
 * open-loop model is already wrong — while costing one small text frame per
 * half-second of agent speech, which is nothing beside the PCM16 flowing the
 * other way.
 *
 * There is no point reporting when the buffer is empty: "nothing outstanding"
 * is what the host already assumes, and a clamp-upward consumer would ignore
 * it anyway.
 */
export const PLAYBACK_PROGRESS_INTERVAL_MS = 500;

/**
 * Upper bound (ms) accepted on a `playback_progress` report.
 *
 * A validation bound, not a tuning knob. The value feeds a clock the host
 * treats as "audio may still be playing", which gates barge-in and the
 * speaking edge — so an absurd report (a buggy client, a hostile one) would
 * pin the agent as permanently speaking and make the session deaf to
 * interruption. Ten minutes is far past any real jitter buffer and still
 * finite. Zod rejects anything above it, and a rejected client message is
 * dropped, which degrades to the open-loop estimate.
 */
export const MAX_PLAYBACK_BUFFERED_MS = 600_000;
