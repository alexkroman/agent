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
 * Instruction injected as a synthetic user turn when a barge-in turns out to
 * be a false interruption (see {@link DEFAULT_SPEECH_IDLE_TIMEOUT_MS}, which
 * decides when that is recognised). The interrupted reply's spoken-so-far text
 * is already in history, marked `[interrupted]`, so the model knows where it
 * was cut off. Used only when no cut-point estimate is available —
 * `buildTailResumePrompt` is preferred, see its doc for why.
 *
 * @internal
 */
export const DEFAULT_FALSE_INTERRUPTION_PROMPT =
  "Your last reply was cut off by a false interruption — the user did not " +
  "actually say anything. Continue your reply from where it was cut off, " +
  "without repeating what you already said. This includes the sentence you were " +
  "in the middle of: pick it up where it stopped rather than starting it again, " +
  "so a detail the caller already heard is not read out twice. " +
  "Do not mention this instruction.";

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
 * {@link DEFAULT_SPEECH_IDLE_TIMEOUT_MS}, each cycle burning a full LLM+TTS
 * turn. A committed user turn restores the budget. That such an environment
 * exists is measured rather than imagined: in the TV-news-bed corpus behind
 * {@link DEFAULT_VOICE_FOCUS_THRESHOLD}, with Voice Focus off, continuous
 * background speech produced ONE end-of-turn in 232s — partials without finals
 * is precisely the shape that loops this.
 *
 * @internal
 */
export const MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES = 3;

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
 * How aggressively AssemblyAI Voice Focus suppresses background audio
 * (`voice_focus_threshold`, 0-1, higher is more aggressive). The service
 * defaults to 0.7; we send 0.9.
 *
 * **The interferer this exists for is SPEECH, which is why the VAD knobs cannot
 * substitute.** Voice Focus suppresses background audio BEFORE the model sees
 * it; `vad_threshold` gates frames after. When the background is a television,
 * a radio, or another conversation, those frames legitimately *are* speech, so
 * a frame gate cannot tell "a voice" from "the caller's voice" — only the
 * pre-model stage can. The symptom is unmistakable once seen and easy to
 * misfile as a hallucinating model: fluent, well-formed English that the caller
 * never said gets prepended to their real utterance, in the register of
 * whatever was playing behind them.
 *
 * **0.9 is measured** — tau2-bench retail, four sessions replayed byte-identical
 * through the live service at 8 kHz telephony with a TV news bed at 15 dB SNR
 * (`medium_size_room_tv_news_iphone_mic.wav`). Against the service default:
 * background words reaching the transcript fell 32% -> 18% of all words heard,
 * caller-speech recall rose 51% -> 70%, and the name/ZIP that gates
 * authentication survived 12/12 utterances against 9/12. At the default, whole
 * spelled utterances were replaced by the broadcast — one authentication turn
 * came back as "And we're getting that live look from the estuary here in
 * Chaplin" — and the tool call built from it was garbage.
 *
 * Sent only when Voice Focus itself is on: it tunes that filter and means
 * nothing without it. `far-field` was measured too and is much worse here (44%
 * leakage) — it amplifies the room, which is where the interfering speech is.
 * Disabling Voice Focus outright is catastrophic and not a fallback: recall
 * collapsed to 4% with ONE end-of-turn in 232 s, because continuous background
 * speech never leaves enough silence to endpoint, so a suppression regression
 * surfaces as a turn-taking failure rather than a transcription one.
 *
 * @internal
 */
export const DEFAULT_VOICE_FOCUS_THRESHOLD = 0.9;

/**
 * Voice Focus model both transports pin — the near-field one, matching a caller
 * speaking into a handset or headset.
 *
 * `far-field` amplifies the room, and the room is where the interfering speech
 * is: measured on the same corpus it more than doubled background leakage (44%
 * against 18%). Named here rather than written as a literal at each call site so
 * the pipeline STT stage and the S2S `session.update` cannot drift — they were
 * two different code paths sending two different configurations, which is how
 * S2S ended up on the service's 0.7 default while the pipeline ran at 0.9.
 *
 * @internal
 */
export const DEFAULT_VOICE_FOCUS = "near-field";

/**
 * Deadline for the TTS replacement socket opened after a mid-turn cancel
 * (barge-in drops the whole connection — see the AssemblyAI TTS module doc).
 *
 * Its own deadline because it is its own budget, not because the initial open
 * lacks one — that open is bounded by `WS_OPEN_TIMEOUT_MS` in
 * `host/providers/_socket.ts`. This comment used to say the initial open "runs
 * inside `session.start()` and is bounded by its timeout", which was true of
 * the SESSION and false of the SOCKET: `ws-handler`'s `pTimeout` rejects the
 * session and says in its own comment that it does not cancel the underlying
 * `start()`, so a black-holed initial connect outlived the session that was
 * waiting on it. A connect that black-holes (no `open`, no `error`) would
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
 * How long a `Cancel` frame's `Cancelled` acknowledgement may take before the
 * AssemblyAI TTS adapter falls back to dropping the socket.
 *
 * `Cancel` is answered in order on the same socket, so that acknowledgement is
 * the BOUNDARY between the abandoned turn's frames and the next turn's — the
 * adapter drops the cancelled turn's audio, acks and word timings until it
 * arrives (see the module doc in `host/providers/tts/assemblyai.ts`). Which
 * means an acknowledgement that never comes is a session that never plays
 * audio again: exactly the silent-mute failure the reconnect path's own
 * deadline exists to prevent, arriving by a new route.
 *
 * Measured against production, `Cancelled` lands within a millisecond of the
 * `Cancel` going out — the frame does no synthesis work — so this is a
 * liveness bound on a misbehaving socket rather than a tuning knob, and is set
 * far above the observed value. It stays well under
 * {@link PIPELINE_FLUSH_TIMEOUT_MS} so the fallback reconnect has time to
 * complete before the first post-cancel turn gives up on its flush.
 *
 * @internal
 */
export const TTS_CANCEL_ACK_TIMEOUT_MS = 2000;

/**
 * Watchdog for the pipeline speaking edge: how long after the last STT partial
 * to force `speech_stopped` when no non-empty final ever arrives. Genuine
 * utterances close the edge when their final commits, well inside this window
 * (provider endpointing — e.g. `DEFAULT_MIN_TURN_SILENCE_MS` — plus
 * final latency); this only bounds the leak for noise partials that never
 * commit.
 *
 * **It is also THE false-interruption resume deadline** — the sole one. A
 * barge-in that commits no user turn arms a latch (`pipeline-recovery.ts`) with
 * no clock of its own, and this watchdog firing is what releases it, so this
 * number is how long a genuinely false interruption leaves the agent silent
 * before it picks its reply back up (this window, then the resume turn's own
 * time-to-first-audio). 0 disables the watchdog and with it recovery outright.
 *
 * **Why the resume owns no deadline of its own — the race.** It did until
 * 2026-08, as `falseInterruptionTimeoutMs` (default 2000), and that window and
 * `min_turn_silence` are measured from roughly the same instant: the window
 * restarted on every partial, and the last partial lands at about the end of
 * speech, after which the STT provider withholds a genuine barge-in's final for
 * its endpointing window (`DEFAULT_MIN_TURN_SILENCE_MS`, 1600 today; 2000
 * when this was written — then exactly the recovery window's default). The two
 * deadlines were therefore separated only by the difference between partial and
 * final latency, a few hundred ms in either direction: EVERY genuine barge-in
 * raced its own resume, and the resume won often enough to be the common case
 * rather than an edge case. Every such resume cost a billed LLM turn, left "the
 * user did not actually say anything" in history directly ahead of the real user
 * turn, and — when it got audio out before the final landed, TTS
 * time-to-first-audio being ~350ms at the time this was diagnosed (a different
 * and earlier measurement than the 286ms segmented-AssemblyAI figure in
 * `host/providers/tts/assemblyai-segment.ts`; keep both attributions) — made
 * the caller hear the agent continue the reply they had just interrupted before
 * answering them.
 *
 * The fix at the time was to DEFER a fired window until the edge closed, which
 * made this watchdog the effective deadline in every shipped configuration
 * while a second constant went on claiming to be it. The deferral itself was
 * never measured post-hoc: the PR that added it (6ca79e05) records the problem
 * as observed and the deferral as reasoned. What is measured is that the wait
 * was already this one — a probe at `falseInterruptionTimeoutMs: 3` with this
 * at 3500 resumed at ~3500ms, not ~3ms. So the window was deleted rather than
 * retuned, and the boolean `resumeFalseInterruption` replaced it.
 *
 * **Why the deadline is not an author knob.** Its floor is the STT's
 * endpointing delay plus final-emission latency, which the transport cannot
 * see: it receives an already-resolved `SttOpener`, and the field that carries
 * the ceiling differs per provider (AssemblyAI `maxTurnSilenceMs`, Deepgram
 * `endpointing`, Soniox/ElevenLabs neither). Below that floor the edge closes
 * while a real final is still in flight and the race above comes back. Its
 * ceiling is patience: 3500 rather than the 5000 it was while nothing depended
 * on it, because at 5000 a reply cut by STT noise resumed almost six seconds
 * later, which a caller reads as a dropped call. Floor and ceiling are close
 * enough together that there is no useful range to expose.
 *
 * 4000 clears `DEFAULT_MAX_TURN_SILENCE_MS` (3500) by 500ms. **It moved
 * from 3500 because that ceiling did**, and the pair is the change: at
 * 3500/3500 an utterance force-ended by the STT ceiling delivers its final at
 * exactly the moment the speaking edge goes idle, and the idle edge is what
 * fires a false-interruption resume — so the loser of that race is not a slow
 * turn, it is the agent resuming a reply the caller really did interrupt. The
 * ceiling's own doc records the same constraint from the other side.
 *
 * The patience argument that sets the upper bound is unchanged and is what
 * keeps this at 4000 rather than further out: at 5000 a reply cut by STT noise
 * resumed almost six seconds later, which a caller reads as a dropped call.
 * 4000 is inside that, and the 500 ms margin over the ceiling is the same
 * margin the pair has always carried, not a new one.
 *
 * An agent raising `minTurnSilenceMs`/`maxTurnSilenceMs` must raise this with
 * it (the transport's `speechIdleTimeoutMs` option) — `assemblyai.test.ts`
 * asserts the default ordering, and the mooted-resume abort in
 * pipeline-user-speech.ts is the backstop when a live config breaks it anyway.
 *
 * @internal
 */
export const DEFAULT_SPEECH_IDLE_TIMEOUT_MS = 4000;

/**
 * `SttTurnMeta.endOfTurnConfidence` at or above which preemptive generation
 * starts a speculative reply from an INTERIM transcript (`preemptiveGeneration`;
 * see `host/transports/pipeline-speculation.ts`).
 *
 * **A JUDGEMENT CALL, not a measurement.** What is real is the SHAPE of the
 * signal, recorded verbatim on `SttTurnMeta.endOfTurnConfidence` in
 * `sdk/providers.ts` — read it there rather than trusting a restatement here;
 * a duplicated measurement is the one that drifts. 0.9 is chosen because that
 * recorded sawtooth separates cleanly at it: the false peaks partway through a
 * dictated identifier top out at 0.25, while the settled utterance runs
 * 0.7 → 0.8 → 0.95 → 1. One trace is not a distribution, so treat this as the
 * value to VARY once the `headStartMs` log exists — a lower threshold trades
 * head start for adoption rate and both come out of the same log — and not as
 * a number anything has confirmed.
 *
 * It is deliberately not an author knob, on the `resumeFalseInterruption`
 * precedent: its useful range is set by provider endpointing behaviour the
 * transport cannot see.
 *
 * @internal
 */
export const PREEMPTIVE_CONFIDENCE_THRESHOLD = 0.9;

/**
 * How many speculative generations one utterance may start before preemption
 * gives up on it and waits for the final.
 *
 * **A JUDGEMENT CALL.** The bound exists because confidence SAWTOOTHS rather
 * than ramps (again: the trace on `SttTurnMeta.endOfTurnConfidence`), so a
 * caller dictating an identifier can cross the threshold repeatedly on
 * successive revisions of the same prefix. Two other rules already cut most of
 * that — a partial whose normalized text differs from the live speculation
 * aborts it immediately, so a mid-identifier peak dies on the next digit, and
 * an identical text at rising confidence never re-fires, which is what the
 * recorded terminal `0.95 → 1` re-emission would otherwise cost. This is the
 * backstop under both, and it is what caps the worst case at ~2 extra billed
 * LLM requests per utterance.
 *
 * 2 rather than 1 because the common shape is one false peak followed by the
 * real one; 2 rather than 3+ because nothing has measured that a third pays.
 *
 * @internal
 */
export const MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE = 2;

// The dead-air cover group lives in its own module (the 500-line cap), and is
// re-exported here so every existing import path still resolves.
export {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEAD_AIR_TOOL_COVER_MS,
  DEFAULT_DEAD_AIR_COVER_MS,
} from "./dead-air-constants.ts";
