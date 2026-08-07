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
   * speech barges in on (aborts) the agent's in-flight reply. Defaults to
   * {@link DEFAULT_MIN_BARGE_IN_WORDS} (2) so one-word backchannels ("yeah",
   * "mm-hmm") don't cut the agent off; set 1 to interrupt on any word.
   */
  minBargeInWords?: number;
  /**
   * Pipeline mode only. Minimum sustained speech (ms since the utterance's
   * first interim transcript) before an interim-triggered barge-in aborts the
   * agent's reply — a duration gate alongside `minBargeInWords`, mirroring
   * LiveKit's `min_interruption_duration`. Committed turns (STT finals) are
   * never gated. Defaults to {@link DEFAULT_INTERRUPTION_MIN_DURATION_MS}
   * (500); set 0 to disable the gate.
   */
  interruptionMinDurationMs?: number;
  /**
   * Pipeline mode only. How long a turn may send nothing to the caller before the transport
   * speaks a short filler, so a long tool chain doesn't sound like a dropped call. MEASURED
   * silence, so a prompt reply pays nothing. Defaults to 5000; `0` disables. The wording is
   * internal and must stay purely declarative — see `DEAD_AIR_COVER_PHRASES` for why.
   */
  deadAirCoverMs?: number;
  /**
   * Pipeline mode only. Phrase spoken when the turn's LLM stream fails, so a
   * provider outage hands the conversation back instead of going silent — a
   * failed turn produces no text, so nothing would otherwise reach TTS.
   * Defaults to {@link DEFAULT_ERROR_PHRASE}; set `""` to disable.
   */
  errorPhrase?: string;
  /**
   * Pipeline mode only. Phrase spoken when a provider fails to open, so a session that cannot
   * start says so instead of holding an open line in silence. Only reachable when TTS itself
   * came up — the usual case, since STT and TTS open independently. Defaults to
   * {@link DEFAULT_START_FAILURE_PHRASE}; set `""` to disable.
   */
  startFailurePhrase?: string;
  /**
   * Pipeline mode only. Resume the agent's reply when a barge-in aborts it and
   * no user turn ever commits (STT noise, a hallucinated partial) — the
   * interruption was a false alarm and the agent would otherwise fall silent
   * mid-thought. Defaults to `true`; `false` disables recovery.
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
   * committed final turns out to say the same thing. Defaults to `true`;
   * `false` makes every speculation path inert.
   *
   * **STILL UNMEASURED in this repo — the default is ON by decision, not by a
   * number.** Nothing here has measured what it saves. Two numbers bound the
   * window it aims at and neither is a claim about the saving: STT endpointing
   * withholds a final for {@link DEFAULT_MIN_TURN_SILENCE_MS} (1600) after the
   * caller stops, and LLM time-to-first-text is p50 1.10s / mean 1.42s
   * (tau2-bench retail, the measurement recorded on
   * `DEFAULT_DEAD_AIR_COVER_MS`). Whether a high-confidence interim actually
   * arrives meaningfully EARLIER than the final is still the open question; the
   * `Pipeline speculation adopted` log line carries `headStartMs` precisely to
   * answer it.
   *
   * What makes shipping it on defensible is therefore the two structural
   * guardrails below rather than evidence of a saving: the WORST case is a
   * discarded stream — one extra billed LLM request for that utterance — and
   * the turn then runs byte-identically to how it runs with the flag off.
   *
   * What it structurally cannot do, by construction rather than by flag (see
   * `pipeline-speculation.ts`): a speculation never reaches TTS, never emits a
   * client frame, never writes either history view, and never EXECUTES a tool —
   * its tool set is declaration-only, so the model cannot continue past a tool
   * call, and a speculation that reaches one is discarded whole. Adoption
   * requires the final to match the speculated text after normalization
   * (case/punctuation only); an extension, a truncation or a revision all
   * discard and the turn runs exactly as it does today.
   *
   * Its reach is therefore BOUNDED BY A MEASUREMENT rather than shown by one:
   * across 815 replies in two tau2-bench retail runs, 28-33% of replies called a
   * tool at all (the distribution recorded on {@link DEFAULT_MAX_STEPS}), so at
   * most the remaining 67-72% can ever be accelerated. On a tool-calling agent
   * this buys nothing and costs one extra billed LLM request per speculating
   * utterance; at most 2 speculations per utterance is the cap.
   *
   * Two measurements are still OWED, and they are now what would justify
   * turning it back OFF rather than on: (a) the `headStartMs`/adoption-rate log
   * over a caller-audio replay run showing the head start is real — if
   * adoption is rare or the head start is ~0, this is pure cost on the 67-72%
   * of replies it can reach — and (b) a tau2-bench retail run at the same 25
   * tasks and seed showing no reward regression. (The in-repo
   * `scripts/voice-replay/` harness that produced these logs has been removed;
   * (a) needs an equivalent instrument first.)
   */
  preemptiveGeneration?: boolean;
}
