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
 * **Every phrase must be purely declarative — a status report, never a request
 * for patience.** Filler is spoken into an open microphone, so anything that
 * asks something of the caller gets ANSWERED, and the answer costs a turn the
 * conversation then has to unwind. Measured on EVA airline record 1.1.2: the
 * agent emitted "Still working on that.", the caller replied "All right, I'll
 * hold" — which barged in, since it clears `DEFAULT_MIN_BARGE_IN_WORDS` — the
 * resume replayed the interrupted sentence verbatim, and the agent was still
 * answering "I'll hold" ("There is no need to hold; the change is complete")
 * two turns later, after the caller had said goodbye. One filler cost a wasted
 * turn, a redundant repetition, and two turns of desync.
 *
 * "Still working on that" and "Just a moment longer" both read as asking the
 * caller to wait. The replacements state what is happening and stop.
 *
 * @internal
 */
export const DEAD_AIR_COVER_PHRASES: readonly string[] = [
  "I'm still checking on this.",
  "This is taking a little longer than usual.",
  "I'm still on it.",
];

/**
 * How long a pipeline turn may send nothing to TTS while tools run before the
 * transport speaks a {@link DEAD_AIR_COVER_PHRASES} filler.
 *
 * {@link DEFAULT_HOLD_PHRASE} only covers a turn whose *first* action is a
 * tool call: once the model has spoken a word it is suppressed for the rest of
 * the turn. A model that says "Let me look that up" and then chains six tool
 * calls therefore goes silent for as long as the chain takes — measured at
 * 15-24s against the tau2-bench retail tasks, well past the point a caller
 * assumes the line is dead. Cover is time-based instead: any gap this long
 * gets filler, whether or not the model already spoke.
 *
 * **Must stay above the MEDIAN tool turn, not below it.** This is cover for the
 * long-chain outlier; at 2000 it was under the ordinary case and fired on
 * essentially every tool turn instead. Measured on the EVA airline run: tool
 * turns averaged 6.24s, so 2000 fired on 93% of them (`pretoolspeech_rate`
 * 0.933) and twice on the 8.7s and 10.5s turns — turning a latency problem into
 * a verbosity one (`verbosity_or_filler_rate` 0.38,
 * `redundant_statements_rate` 0.60) and, once, derailing the call outright (see
 * {@link DEAD_AIR_COVER_PHRASES}). 5000 sits below the 6.24s mean but above the
 * turns that complete normally, so a routine single tool call now finishes
 * unaccompanied and only a genuine chain draws cover.
 *
 * @internal
 */
export const DEFAULT_DEAD_AIR_COVER_MS = 5000;

/**
 * Ceiling on the dead-air cover's exponential backoff, so a long tool chain
 * settles into a steady heartbeat instead of drifting into silence.
 *
 * Uncapped doubling from {@link DEFAULT_DEAD_AIR_COVER_MS} put the fillers of a
 * 90s chain at 0, 2, 6, 14, 30 and 62s — gaps of 2, 4, 8, 16 and 32s. Net of
 * each phrase's own ~1.3s of audio that is roughly 0.7s, 2.7s, 6.7s, 14.6s and
 * 30.6s of actual silence: two fillers almost on top of each other at the start,
 * and then gaps well past the point where the caller concludes the line is dead
 * — reintroducing, at the tail of exactly the long chains it exists for, the
 * dead air the mechanism is there to cover. Measured against the tau2-bench
 * retail runs, whose 45s tool chains ended with a silent 15s stretch.
 *
 * At 8000 the same chain reassures roughly every 6.5s of silence once it has
 * ramped, which is the cadence a human on a phone keeps ("bear with me…"),
 * while the ramp still keeps a short chain from chattering.
 *
 * @internal
 */
export const DEAD_AIR_COVER_MAX_MS = 8000;

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

/**
 * Watchdog for the pipeline speaking edge: how long after the last STT partial
 * to force `speech_stopped` when no non-empty final ever arrives. Genuine
 * utterances close the edge when their final commits, well inside this window
 * (provider endpointing — e.g. {@link DEFAULT_MIN_TURN_SILENCE_MS} — plus
 * final latency); this only bounds the leak for noise partials that never
 * commit.
 *
 * **It is also what releases a deferred false-interruption resume**, so it sets
 * how long a genuinely false interruption leaves the agent silent before it
 * picks its reply back up (this window, then the resume turn's own
 * time-to-first-audio). That is why it is 3500 rather than the 5000 it was while
 * nothing depended on it: at 5000 a reply cut by STT noise resumed almost six
 * seconds later, which a caller reads as a dropped call. The floor is the
 * endpointing delay plus final-emission latency — below `min_turn_silence` the
 * edge would close while a real final is still in flight, putting back the race
 * that {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS} documents. 3500 clears the
 * 2000 default by 1.5s; an agent raising `minTurnSilenceMs` past ~3000 should
 * raise this with it (the transport's `speechIdleTimeoutMs` option), and the
 * mooted-resume abort in pipeline-user-speech.ts is the backstop if it does not.
 *
 * @internal
 */
export const DEFAULT_SPEECH_IDLE_TIMEOUT_MS = 3500;
