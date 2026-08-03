// Copyright 2025 the AAI authors. MIT license.

/**
 * Pipeline/provider tuning constants — dead-air cover, false-interruption
 * recovery, TTS batching, STT framing, and provider connect budgets. Split
 * from `constants.ts` for file-length reasons and re-exported there, so the
 * import path is unchanged. All internal transport tuning, not agent API.
 *
 * @internal
 */

/**
 * Fillers cycled through while a tool chain keeps the line silent, in order.
 *
 * Distinct from {@link DEFAULT_HOLD_PHRASE} and from each other because the
 * gap they cover repeats: "One moment." six times reads as a stuck loop, which
 * is its own kind of broken. The wait between them backs off exponentially, so
 * a long chain thins out rather than chattering.
 *
 * @internal
 */
export const DEAD_AIR_COVER_PHRASES: readonly string[] = [
  "Still working on that.",
  "Just a moment longer.",
  "Almost there.",
];

/**
 * Instruction injected as a synthetic user turn when a barge-in turns out to
 * be a false interruption (see {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS}).
 * The interrupted reply's spoken-so-far text is already in history, marked
 * `[interrupted]`, so the model knows where it was cut off.
 *
 * @internal
 */
export const DEFAULT_FALSE_INTERRUPTION_PROMPT =
  "Your last reply was cut off by a false interruption — the user did not " +
  "actually say anything. Continue your reply from where it was cut off, " +
  "without repeating what you already said. Do not mention this instruction.";

/**
 * Minimum estimated unheard playback (ms) before a barge-in on the client
 * playback tail — the reply finished server-side but its audio is still
 * playing out — arms false-interruption recovery (pipeline mode).
 *
 * A tail barge-in used to never recover: the reply was already complete in
 * history, so there was "no cut point to continue from", and a noise partial
 * landing in that window killed the rest of the reply permanently — full
 * transcript on screen, voice dead mid-sentence, no error anywhere. Recovery
 * now estimates the cut point from the playback clock and resumes. Below this
 * threshold the caller heard essentially everything, and a resume would add a
 * trailing fragment to a reply that already landed.
 *
 * @internal
 */
export const TAIL_RESUME_MIN_UNHEARD_MS = 1500;

/**
 * Cap on back-to-back false-interruption resumes (pipeline mode) before the
 * user must speak again, mirroring {@link MAX_CONSECUTIVE_SILENCE_NUDGES}.
 * Without it, persistent cross-talk loops barge-in → resume → barge-in every
 * {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS}, each cycle burning a full
 * LLM+TTS turn. A committed user turn restores the budget.
 *
 * @internal
 */
export const MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES = 3;

/**
 * Pipeline mode: max characters of LLM text batched before a TTS provider
 * send. The word-coalescing stream transform (pipeline-smooth.ts) emits
 * one chunk per word; forwarding each word as its own provider message is
 * ~1 wire frame per word. The TTS send path batches to clause/punctuation
 * boundaries or this many characters — after the first chunk, which is
 * always forwarded immediately to preserve time-to-first-byte.
 *
 * @internal
 */
export const TTS_COALESCE_MAX_CHARS = 32;

/**
 * STT frame coalescing (host-side provider openers). Browser/telephony
 * clients stream ~20 ms mic frames; forwarding each one is ~50 provider
 * messages per second (and AssemblyAI rejects frames outside [50, 1000] ms).
 * Openers accumulate inbound PCM to ~STT_FRAME_TARGET_MS frames, split
 * over-long chunks at STT_FRAME_MAX_MS, and only flush a close-time tail
 * of at least STT_FRAME_FLOOR_MS (providers with no floor pass 0).
 *
 * @internal
 */
export const STT_FRAME_TARGET_MS = 100;
/** @internal */
export const STT_FRAME_MAX_MS = 1000;
/** @internal */
export const STT_FRAME_FLOOR_MS = 50;

/**
 * Streaming STT connect budget — one attempt's deadline, how many extra
 * attempts follow a transient failure, and the wait between them.
 *
 * The `assemblyai` SDK defaults to a **1000 ms** per-attempt deadline, and it
 * covers far more than a socket open: the timer is armed before the WebSocket
 * is constructed and only cleared when the server's `Begin` message arrives,
 * so DNS + TCP + TLS + upgrade + the service's own session-start latency all
 * have to fit. A handshake that measures ~50 ms of network still blew that
 * budget in practice — a slow `Begin` or a momentarily blocked host event loop
 * is enough, since this is a wall-clock `setTimeout` rather than an I/O
 * deadline. Every attempt then failed the same way and the session died with a
 * fatal `stt_connect_failed`, which reads as an outage and is not one.
 *
 * All three are pinned rather than left to the SDK so the worst case is
 * arithmetic we own and can hold against
 * {@link DEFAULT_SESSION_START_TIMEOUT_MS} — the STT open runs inside
 * `session.start()`, so a connect budget larger than that deadline can only
 * ever surface as the less specific "session.start() timed out". With these
 * values: 3 attempts x 2500 ms + 2 x 500 ms = 8500 ms < 10000 ms. Raising any
 * of them means re-checking that sum (`assemblyai.test.ts` asserts it).
 *
 * @internal
 */
export const STT_CONNECT_TIMEOUT_MS = 2500;
/** @internal */
export const STT_CONNECT_MAX_RETRIES = 2;
/** @internal */
export const STT_CONNECT_RETRY_DELAY_MS = 500;

/**
 * Deadline for the TTS replacement socket opened after a mid-turn cancel
 * (barge-in drops the whole connection — see the AssemblyAI TTS module doc).
 *
 * Unlike the initial open, which runs inside `session.start()` and is bounded
 * by its timeout, the cancel-reconnect runs mid-session with no deadline
 * upstream. A connect that black-holes (no `open`, no `error`) would otherwise
 * leave the adapter queueing frames forever: every later turn's flushes count
 * as sent while nothing reaches the wire, so each reply burns the full
 * {@link PIPELINE_FLUSH_TIMEOUT_MS} in silence and the session is mute until
 * the OS-level TCP timeout — if one ever fires. Kept under the flush timeout
 * so the failure surfaces as a specific reconnect error before the first
 * post-cancel turn gives up.
 *
 * @internal
 */
export const TTS_RECONNECT_TIMEOUT_MS = 8000;
