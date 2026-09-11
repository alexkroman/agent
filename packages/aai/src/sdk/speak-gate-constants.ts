// Copyright 2026 the AAI authors. MIT license.
/**
 * The two windows that decide WHEN the agent's audio may go out, as opposed to
 * when the agent decided to speak.
 *
 * Everything else in this pipeline's turn-taking answers "has the caller
 * finished?" — the endpointing pair, the barge-in gates, the phrase lists.
 * These two answer the other question, and they are separate for a reason the
 * endpointing knobs make concrete: `min_turn_silence` is both the moment the
 * turn is judged over AND the moment the reply starts being produced, so
 * tuning one moves the other. A floor at the END of the pipeline decouples
 * them — "wait 300ms before speaking" costs 300ms of latency and nothing else,
 * where "wait 300ms longer before deciding the turn ended" changes which
 * utterances get split.
 *
 * Both are Vapi's, both are ours at **0**, and neither is measured on this
 * corpus. See each constant.
 *
 * @module
 */

/**
 * Minimum delay between a reply starting and its first audio reaching the
 * caller, in ms. Vapi's `startSpeakingPlan.waitSeconds` (their default 0.4s,
 * range 0-5).
 *
 * Vapi's rationale, verbatim: *"This is the minimum it will wait but if there
 * is latency in the pipeline, this minimum will be exceeded. This is intended
 * as a stopgap in case the pipeline is moving too fast."*
 *
 * **0 here, and that is a default rather than a judgement about the value.**
 * On this pipeline the floor would almost never bind: measured p50 response
 * latency is ~4.1s and time-to-first-token alone is p50 ~700ms-1.1s, against
 * which a 400ms floor is inert except on the turns that are already fast. So
 * shipping Vapi's 0.4 would change nothing most of the time and slow down
 * exactly the turns that feel good, with no run behind it. 0 keeps the shipped
 * path byte-identical to what the tau2-bench numbers in
 * `endpointing-constants.ts` were measured on.
 *
 * **What would justify raising it** is the failure it is for: the agent
 * answering so promptly that it reads as having interrupted — which on this
 * pipeline shows up as the caller re-starting their sentence. The instrument
 * is the give-up-probe / restart rate per call that
 * `DEFAULT_MIN_BARGE_IN_WORDS` already tracks.
 *
 * @defaultValue `0`
 */
export const DEFAULT_START_SPEAKING_FLOOR_MS = 0;

/**
 * Longest start-speaking floor an agent may declare, in ms — Vapi's own range
 * ceiling (0-5s), kept because the argument transfers: past a few seconds the
 * caller has concluded the line is dead and takes the floor back, which is a
 * worse outcome than the one the floor is buying.
 *
 * @internal
 */
export const MAX_START_SPEAKING_FLOOR_MS = 5000;

/**
 * How long agent audio stays blocked after a REAL interruption, in ms. Vapi's
 * `stopSpeakingPlan.backoffSeconds` (their default 1.0s).
 *
 * The window exists because a barge-in is not instantaneous from the caller's
 * side: they took the floor and are still talking, and an agent that starts
 * its next reply the moment the abort lands is talking over the utterance that
 * interrupted it. This blocks the OUTPUT, so it is sequential with
 * {@link DEFAULT_START_SPEAKING_FLOOR_MS} and never cumulative — the two are
 * one deadline, `max(floor, backoff)`, not a sum.
 *
 * **0 here, for the same reason the floor is.** This pipeline already has a
 * mechanism in that window — `resumeFalseInterruption` — whose whole design is
 * that the resume must not race the caller's real turn, and it waits on the
 * transcript stream going quiet rather than on a fixed deadline
 * (`PipelineVoiceTuning.resumeFalseInterruption` carries why the wait cannot
 * be a knob). A fixed 1s block on top of that is a second, blinder answer to
 * the same question, and adding it un-measured risks the failure that one was
 * built to avoid.
 *
 * **What would justify raising it** is a run showing the agent's post-barge-in
 * reply landing ON TOP of the caller's interrupting utterance — measurable as
 * overlap between agent audio and a committed user final in the session event
 * stream.
 *
 * @defaultValue `0`
 */
export const DEFAULT_INTERRUPTION_BACKOFF_MS = 0;

/**
 * Longest post-interruption backoff an agent may declare, in ms.
 *
 * 5000 for the same reason as the floor's cap, and with one extra: this window
 * blocks audio while the turn behind it has already been computed, so every
 * millisecond of it is dead air the caller pays for twice — once waiting, once
 * wondering.
 *
 * @internal
 */
export const MAX_INTERRUPTION_BACKOFF_MS = 5000;
