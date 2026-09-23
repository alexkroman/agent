// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline-only voice-UX tuning fields of an agent definition.
 *
 * Split out of `types.ts` for two reasons. It was at exactly the 500-line cap,
 * so nothing could be added to it — and these fields share one rule that reads
 * better stated once than repeated per member: **every one of them is
 * implemented by the pipeline transport alone**, so setting one on an S2S agent
 * is a compile error naming the rule (`PipelineOnlyMisuse` in `define.ts`) and a
 * deploy-time rejection (`assertPipelineTuning` in `config-rules.ts`), rather
 * than a silent no-op. `define.ts` and `config-rules.ts` both DERIVE their field
 * list from this interface, so a field added here cannot skip either gate.
 *
 * `AgentDef` extends it; the docs below are the authoring surface.
 */

/**
 * Pipeline-mode voice-UX tuning, extended by {@link AgentDef}.
 *
 * @public
 */
export interface PipelineVoiceTuning {
  /**
   * Pipeline mode only. Minimum words in an interim transcript before user
   * speech barges in on (aborts) the agent's in-flight reply. Set 1 to
   * interrupt on any word.
   *
   * @defaultValue `2` (`DEFAULT_MIN_BARGE_IN_WORDS`) — so one-word
   * backchannels ("yeah", "mm-hmm") don't cut the agent off.
   */
  minBargeInWords?: number;
  /**
   * Pipeline mode only. Minimum sustained speech (ms since the utterance's
   * first interim transcript) before an interim-triggered barge-in aborts the
   * agent's reply — a duration gate alongside `minBargeInWords`, mirroring
   * LiveKit's `min_interruption_duration`. Committed turns (STT finals) are
   * never gated. Set 0 to disable the gate.
   *
   * @defaultValue `500` (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`)
   */
  interruptionMinDurationMs?: number;
  /**
   * Pipeline mode only. Minimum delay between a reply starting and its first
   * audio reaching the caller, in ms — a floor at the END of the pipeline, so
   * it decouples "when did I decide the turn ended" from "when do I start
   * speaking". Vapi's `waitSeconds`.
   *
   * It is a MINIMUM: a pipeline slower than this pays nothing, and only a
   * reply that was ready sooner waits.
   *
   * @defaultValue `0` (`DEFAULT_START_SPEAKING_FLOOR_MS`) — today's behaviour.
   * Vapi's own default is 0.4s; see that constant for why this one is not.
   */
  startSpeakingFloorMs?: number;
  /**
   * Pipeline mode only. How long agent audio stays blocked after a real
   * interruption, in ms. Vapi's `backoffSeconds`.
   *
   * SEQUENTIAL with `startSpeakingFloorMs`, never cumulative: the two are one
   * deadline, `max(floor, backoff)`.
   *
   * @defaultValue `0` (`DEFAULT_INTERRUPTION_BACKOFF_MS`) — today's behaviour.
   * Vapi's own default is 1.0s; see that constant for why this one is not.
   */
  interruptionBackoffMs?: number;
  /**
   * Pipeline mode only. How long a turn may send nothing to the caller before
   * the transport speaks a short filler, so a long tool chain doesn't sound
   * like a dropped call. MEASURED silence, so a prompt reply pays nothing; `0`
   * disables. The wording is internal and must stay purely declarative — see
   * `DEAD_AIR_COVER_PHRASES` for why.
   *
   * @defaultValue `2400` (`DEFAULT_DEAD_AIR_COVER_MS`)
   */
  deadAirCoverMs?: number;
  /**
   * Pipeline mode only. Phrase spoken when the turn's LLM stream fails, so a
   * provider outage hands the conversation back instead of going silent — a
   * failed turn produces no text, so nothing would otherwise reach TTS. Set
   * `""` to disable.
   *
   * @defaultValue `"Sorry, I had a problem just then. Could you say that
   * again?"` (`DEFAULT_ERROR_PHRASE`)
   */
  errorPhrase?: string;
  /**
   * Pipeline mode only. Phrase spoken when a provider fails to open, so a session that cannot
   * start says so instead of holding an open line in silence. Only reachable when TTS itself
   * came up — the usual case, since STT and TTS open independently. Set `""`
   * to disable.
   *
   * @defaultValue `"I am sorry, I am having trouble with my connection and
   * cannot hear you. Please hang up and call back."`
   * (`DEFAULT_START_FAILURE_PHRASE`)
   */
  startFailurePhrase?: string;
  /**
   * Pipeline mode only. Resume the agent's reply when a barge-in aborts it and
   * no user turn ever commits (STT noise, a hallucinated partial) — the
   * interruption was a false alarm and the agent would otherwise fall silent
   * mid-thought.
   *
   * @defaultValue `true`; `false` disables recovery.
   *
   * The WAIT is not an author knob: a resume must not race the caller's real
   * turn, whose final the STT withholds for an endpointing window the transport
   * cannot see, so it fires when the transcript stream goes quiet with no final
   * rather than on a deadline of its own.
   */
  resumeFalseInterruption?: boolean;
  /**
   * Pipeline mode only. Start generating the reply from a high-confidence
   * INTERIM transcript, and adopt that already-running stream when the
   * committed final turns out to say the same thing.
   *
   * @defaultValue `false` — measured on a tool-calling agent and not worth its
   * cost there. Set `true` where the arithmetic plausibly differs: a text-heavy
   * agent, or a longer head start from later endpointing.
   *
   * @remarks
   * **Why it is off.** A `headStartMs`/adoption-rate log over a tau2-bench
   * retail run: 16 speculations started, 14 adopted at a p50 0.44s head start,
   * and 5 of those 14 (36%) poisoned after adoption by a tool call — unusable
   * whole, so the generation is discarded and the request reissued, each having
   * burned p50 0.69s first. Net +8ms per caller turn against a p50 first word of
   * ~1.0s, for 44% of its LLM requests thrown away.
   *
   * The head start does not survive contact with time-to-first-token: 0.44s
   * against a p50 of 1.10s, so at adoption the speculation has generated
   * nothing and whether its first part will be text or a tool call cannot be
   * known then. A gate on "has it produced text" was tried and reverted — it
   * rejects essentially every adoption, keeping the wasted request and losing
   * the benefit.
   *
   * Its reach is bounded independently of that: across 815 replies in two
   * tau2-bench retail runs, 28-33% of replies called a tool at all (the
   * distribution recorded on `DEFAULT_MAX_STEPS`), so at most the
   * remaining 67-72% can ever be accelerated.
   *
   * **What it structurally cannot do**, by construction rather than by flag:
   * a speculation never reaches TTS, never
   * emits a client frame, never writes either history view, and never EXECUTES
   * a tool — its tool set is declaration-only, so the model cannot continue past
   * a tool call, and a speculation that reaches one is discarded whole. Adoption
   * requires the final to match the speculated text after normalization
   * (case/punctuation only); an extension, a truncation or a revision all
   * discard and the turn runs exactly as it does with the flag off. At most 2
   * speculations per utterance. So the worst case is one extra billed LLM
   * request for that utterance.
   *
   * Turning it back on by default is owed a tau2-bench run at the same tasks
   * and seed showing no reward regression.
   */
  preemptiveGeneration?: boolean;
  /**
   * Pipeline mode only. Cap ONE user turn's length — by words heard, by
   * elapsed time, or both — see {@link UserTurnLimit}.
   *
   * @defaultValue unset — no cap on a single user turn's length.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Triage",
   *   // Answer after 60 words or 20 seconds, whichever the caller reaches first.
   *   userTurnLimit: { maxWords: 60, maxDurationMs: 20_000 },
   * });
   * ```
   */
  userTurnLimit?: UserTurnLimit;
  /**
   * Pipeline mode only. WHO decides that the caller's turn is over.
   *
   * - `"auto"` — the transcriber does, on a pause. What every agent has always
   *   done.
   * - `"manual"` — the CLIENT does, which is push-to-talk. The caller's audio
   *   reaches the transcriber only between a `user_turn_start` and the
   *   `user_turn_commit` or `user_turn_clear` that closes it (`aai-ui`'s
   *   `startUserTurn` / `commitUserTurn` / `clearUserTurn`, or its
   *   `usePushToTalk` hook). Everything transcribed in that window, across
   *   however many pauses, is ONE turn, and nothing is answered until the
   *   commit. Outside the window the microphone is replaced with silence
   *   server-side, so a caller talking to someone else in the room is never
   *   heard.
   *
   * Under `"manual"` the caller's speech never barges in by itself — opening a
   * turn is what interrupts the agent, so the button IS the barge-in — and
   * preemptive generation is skipped, since no pause is a turn boundary. A
   * `userTurnLimit` still applies and, when it fires, commits the turn exactly
   * as the client's commit would have.
   *
   * @defaultValue `"auto"`
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Walkie",
   *   // Nothing the caller says is answered until they let go of the button.
   *   turnDetection: "manual",
   * });
   * ```
   */
  turnDetection?: "auto" | "manual";
}

/**
 * A cap on ONE user turn — see {@link PipelineVoiceTuning.userTurnLimit}.
 *
 * End-of-turn detection is the STT provider's, and it is driven by SILENCE: a
 * caller who never pauses never ends a turn, so a monologue holds the floor
 * for as long as it runs and the agent cannot answer, redirect or hand off
 * until it stops. This is the bound on that. When the open utterance crosses
 * either cap the runtime asks the transcriber to END THE TURN NOW, exactly as
 * a pause would have — the words heard so far commit as the caller's turn, the
 * agent replies to them, and whatever the caller says next opens the next turn
 * — and a `user-turn.exceeded` event records that it happened.
 *
 * Both members are optional; set one or both. A limit that names neither is
 * refused at config time rather than accepted as a cap on nothing.
 *
 * Two things it is NOT: it is not a barge-in gate (`minBargeInWords` and
 * `interruptionMinDurationMs` decide whether the caller's speech interrupts a
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
   * is what the transcriber HEARD, exactly as `minBargeInWords` is.
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
