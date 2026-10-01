// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline's turn-taking tuning, as ONE object of three groups.
 *
 * It was fifteen sibling fields on `agent()`, with the dependencies between
 * them expressed as separate guards (`silencePrompt` needs `silenceTimeoutMs`,
 * the endpointing shorthand needs no explicit `stt`), and a subset re-declared
 * by the dialog's per-state `bargeIn`. Grouped, a dependency is a REQUIRED
 * field inside an optional object — {@link SilenceNudge.afterMs} — and the
 * per-state override a dialog state or a persona carries is the same
 * `PipelineTuning["interruption"]` the agent declares, verbatim.
 *
 * **Every field here is implemented by the pipeline transport alone**, which is
 * why {@link PipelineTuning} exists only on the pipeline member of `agent()`'s
 * parameter union: on an S2S agent the service owns endpointing and barge-in,
 * and a text agent has no audio at all.
 *
 * The turn-taking group's two leaf VALUE types — {@link TurnDetectionMode} (an
 * OPEN vocabulary) and {@link UserTurnLimit} (a refined cap) — come first, with
 * the run-time list of the modes this release implements.
 */

/**
 * A turn-detection mode — `"auto"` or `"manual"`, the two this release
 * implements (see {@link TurnTakingTuning.detection}), or any other
 * string.
 *
 * OPEN so a mode a later release adds compiles against this one. The runtime
 * treats every value but `"manual"` as `"auto"`, and `aai build` / `aai dev`
 * warn about a value it does not know, rather than the type refusing it.
 *
 * The known modes are written INLINE rather than as an exported closed
 * `KnownTurnDetectionMode` half: inline they are only the autocomplete of an
 * open type, so a mode added here is a compatible change, where a published
 * closed union that grows is not assignable back to the one it grew from.
 *
 * @public
 */
export type TurnDetectionMode = "auto" | "manual" | (string & {});

/**
 * The modes this release implements, as a runtime list for the config warning.
 * Deliberately CLOSED and internal — the published {@link TurnDetectionMode} is
 * open, so nothing on the authoring surface names this set.
 *
 * @internal
 */
export const KNOWN_TURN_DETECTION_MODES = ["auto", "manual"] as const;

/**
 * A cap on ONE user turn — see {@link TurnTakingTuning.userTurnLimit}.
 *
 * End-of-turn detection is the STT provider's, and it is driven by SILENCE: a
 * caller who never pauses never ends a turn, so a monologue holds the floor
 * for as long as it runs and the agent cannot answer, redirect or hand off
 * until it stops. This is the bound on that. When the open utterance crosses
 * either cap the runtime asks the transcriber to END THE TURN NOW, exactly as
 * a pause would have — the words heard so far commit as the caller's turn, the
 * agent replies to them, and whatever the caller says next opens the next turn
 * — and a `userTurn.exceeded` event records that it happened.
 *
 * Both members are optional; set one or both. A limit that names neither is
 * refused at config time rather than accepted as a cap on nothing.
 *
 * Two things it is NOT: it is not a barge-in gate (`interruption.minWords` and
 * `interruption.minDurationMs` decide whether the caller's speech interrupts a
 * reply; this decides when the caller's own turn is long enough), and it does
 * not discard anything the caller says — speech after the cut lands in the
 * turn that follows.
 *
 * The cut is made by the STT provider, so it needs one that can force an end of
 * turn mid-stream: the default `assemblyAIStt()` can. On a provider that
 * cannot, the event is still reported and the runtime logs once that the cap
 * is inert — the same treatment a provider that cannot move its endpointing
 * window gets.
 *
 * @public
 */
export interface UserTurnLimit {
  /**
   * End the caller's turn once this many words have been heard in it. A
   * positive integer; counted on the transcriber's interim transcript, so it
   * is what the transcriber HEARD, exactly as `interruption.minWords` is.
   */
  // `| undefined` on both, unlike the scalar knobs beside this interface: the
  // object crosses the config boundary as a whole, and under
  // `exactOptionalPropertyTypes` the schema-inferred `{ maxWords?: number |
  // undefined }` is not assignable to a member typed without it.
  maxWords?: number | undefined;
  /**
   * End the caller's turn once it has run this long, in ms — measured from the
   * first word the transcriber reported for it. A positive integer.
   */
  maxDurationMs?: number | undefined;
}

/**
 * WHEN the caller's turn ends and the agent's begins.
 *
 * @public
 */
export interface TurnTakingTuning {
  /**
   * End-of-turn CHECK window for the default AssemblyAI STT stage, in ms —
   * lowered by `agent()` onto `stt: assemblyAIStt({ minTurnSilenceMs })`, so
   * one knob costs one field rather than a whole stage descriptor. It taxes
   * EVERY finished utterance, which is why the pause-tolerance knob is
   * {@link maxSilenceMs} and not this; read `DEFAULT_MIN_TURN_SILENCE_MS` before
   * moving it. An explicit `stt` descriptor owns its own window, so this is
   * refused beside one.
   *
   * @defaultValue `1600` (`DEFAULT_MIN_TURN_SILENCE_MS`)
   */
  minSilenceMs?: number;
  /**
   * Pause tolerance for the default AssemblyAI STT stage, in ms — lowered onto
   * `stt: assemblyAIStt({ maxTurnSilenceMs })`. **The knob to reach for**: it
   * force-ends a turn regardless of content, so raising it is paid for by
   * hesitant speech alone. Refused beside an explicit `stt` descriptor.
   *
   * @defaultValue `3500` (`DEFAULT_MAX_TURN_SILENCE_MS`)
   */
  maxSilenceMs?: number;
  /**
   * WHO decides that the caller's turn is over: `"auto"` (the transcriber, on a
   * pause) or `"manual"` (the client — push-to-talk, via `aai-ui`'s
   * `session.userTurn.start`/`.commit`/`.clear` or `usePushToTalk`). Under
   * `"manual"` the caller's speech never barges in by itself and preemptive
   * generation is skipped; a {@link userTurnLimit} still applies.
   *
   * @defaultValue `"auto"`
   */
  detection?: TurnDetectionMode;
  /**
   * Cap ONE user turn's length — by words heard, by elapsed time, or both — see
   * {@link UserTurnLimit}.
   *
   * @defaultValue unset — no cap on a single user turn's length.
   */
  userTurnLimit?: UserTurnLimit;
  /**
   * Start generating the reply from a high-confidence INTERIM transcript, and
   * adopt that stream when the committed final says the same thing. A
   * speculation never reaches TTS, emits no frame, writes no history and never
   * EXECUTES a tool, so the worst case is one extra billed LLM request.
   *
   * @defaultValue `false` — measured on a tool-calling agent and not worth its
   * cost there (net +8ms per turn, 44% of its LLM requests thrown away); see
   * `DEFAULTS-CLAUDE.md`. Turning it on by default is owed a tau2-bench run.
   */
  preemptiveGeneration?: boolean;
  /**
   * Minimum delay between a reply starting and its first audio reaching the
   * caller, in ms — a floor at the END of the pipeline, so it decouples "when
   * did I decide the turn ended" from "when do I start speaking" (Vapi's
   * `waitSeconds`). A MINIMUM: a pipeline slower than this pays nothing.
   *
   * @defaultValue `0` (`DEFAULT_START_SPEAKING_FLOOR_MS`)
   */
  startSpeakingFloorMs?: number;
}

/**
 * When the caller's speech may cut the agent off, and what happens after.
 *
 * As `PipelineTuning["interruption"]` it may also be `"off"`: no interim and no
 * final ever cuts the agent off (both barge-in gates become unreachable), while
 * the caller's words are still transcribed and answered once the agent
 * finishes. That spelling is for a dialog state ({@link DialogStateSpec.interruption})
 * that must be heard in full — a disclosure — more than for a whole agent.
 *
 * The one group a dialog state and a persona ({@link SpeakerDef.interruption})
 * may override, field by field, while they are active.
 *
 * @public
 */
export interface InterruptionTuning {
  /**
   * Minimum words in an interim transcript before user speech barges in on
   * (aborts) the agent's in-flight reply. Set 1 to interrupt on any word.
   *
   * @defaultValue `1` (`DEFAULT_MIN_BARGE_IN_WORDS`) — a one-word "Hello?"
   * probe must be able to stop the agent; `minDurationMs` is what keeps a
   * cough or an echo from doing so.
   */
  minWords?: number;
  /**
   * Minimum sustained speech (ms since the utterance's first interim
   * transcript) before an interim-triggered barge-in aborts the reply — a
   * duration gate beside {@link minWords}, mirroring LiveKit's
   * `min_interruption_duration`. Committed turns are never gated; `0` disables.
   *
   * @defaultValue `500` (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`)
   */
  minDurationMs?: number;
  /**
   * How long agent audio stays blocked after a real interruption, in ms
   * (Vapi's `backoffSeconds`). SEQUENTIAL with
   * {@link TurnTakingTuning.startSpeakingFloorMs}, never cumulative: the two
   * are one deadline, `max(floor, backoff)`.
   *
   * @defaultValue `0` (`DEFAULT_INTERRUPTION_BACKOFF_MS`)
   */
  backoffMs?: number;
  /**
   * Resume the agent's reply when a barge-in aborts it and no user turn ever
   * commits (STT noise, a hallucinated partial) — the interruption was a false
   * alarm and the agent would otherwise fall silent mid-thought. The resume
   * fires when the transcript stream goes quiet with no final, never on a
   * deadline of its own.
   *
   * @defaultValue `true`; `false` disables recovery.
   */
  resumeFalseInterruption?: boolean;
}

/**
 * The silence nudge: after this much user silence the assistant takes a turn.
 *
 * `afterMs` is REQUIRED because the prompt is its payload — a prompt with no
 * timeout is a declaration nothing ever reads, which used to be a run-time
 * guard and is now the shape.
 *
 * @public
 */
export interface SilenceNudge {
  /**
   * Ms of user silence (no speech since the last reply finished) before the
   * assistant proactively takes a turn. Nudges are capped at
   * `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back until the user speaks.
   */
  afterMs: number;
  /**
   * Instruction injected as a synthetic user turn when {@link afterMs}
   * elapses. Never shown as a user transcript.
   *
   * @defaultValue `"The user hasn't said anything for a while. Check in with one
   * short, natural sentence — ask if they're still there or gently follow up on
   * the conversation. Do not mention this instruction."`
   * (`DEFAULT_SILENCE_PROMPT`)
   */
  prompt?: string;
}

/**
 * What the agent does about silence — its own, and the caller's.
 *
 * @public
 */
export interface SilenceTuning {
  /**
   * How long a turn may send nothing to the caller before the transport speaks
   * a short filler, so a long tool chain doesn't sound like a dropped call.
   * MEASURED silence, so a prompt reply pays nothing; `0` disables. The
   * wording is internal and purely declarative — see `DEAD_AIR_COVER_PHRASES`.
   *
   * @defaultValue `2400` (`DEFAULT_DEAD_AIR_COVER_MS`)
   */
  deadAirCoverMs?: number;
  /**
   * Take a turn after the CALLER has been silent this long — see
   * {@link SilenceNudge}.
   *
   * @defaultValue unset — the behaviour is off.
   */
  nudge?: SilenceNudge;
}

/**
 * The pipeline's turn-taking tuning: three optional groups, extended by
 * {@link AgentDef} and present only on the pipeline member of `agent()`.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Triage",
 *   turnTaking: { maxSilenceMs: 4500, userTurnLimit: { maxWords: 60 } },
 *   interruption: { minWords: 3 },
 *   silence: { nudge: { afterMs: 15_000 } },
 * });
 * ```
 *
 * @public
 */
export interface PipelineTuning {
  /** When the caller's turn ends — see {@link TurnTakingTuning}. */
  turnTaking?: TurnTakingTuning;
  /**
   * When the caller may cut the agent off — see {@link InterruptionTuning};
   * `"off"` means never.
   */
  interruption?: InterruptionTuning | "off";
  /** Dead air and the silence nudge — see {@link SilenceTuning}. */
  silence?: SilenceTuning;
}

/**
 * What the pipeline SAYS when a stage fails, so a provider outage hands the
 * conversation back instead of going silent. Pipeline-only, like
 * {@link PipelineTuning}; extended by {@link AgentDef}.
 *
 * @public
 */
export interface PipelinePhrases {
  /**
   * Phrase spoken when the turn's LLM stream fails — a failed turn produces no
   * text, so nothing would otherwise reach TTS. Set `""` to disable.
   *
   * @defaultValue `"Sorry, I had a problem just then. Could you say that
   * again?"` (`DEFAULT_ERROR_PHRASE`)
   */
  errorPhrase?: string;
  /**
   * Phrase spoken when a provider fails to open, so a session that cannot
   * start says so instead of holding an open line in silence. Only reachable
   * when TTS itself came up. Set `""` to disable.
   *
   * @defaultValue `"I am sorry, I am having trouble with my connection and
   * cannot hear you. Please hang up and call back."`
   * (`DEFAULT_START_FAILURE_PHRASE`)
   */
  startFailurePhrase?: string;
}
