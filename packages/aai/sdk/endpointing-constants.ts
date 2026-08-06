// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI end-of-turn detection: the min/max turn-silence pair.
 *
 * Split out of `constants.ts` (which re-exports them, so `@alexkroman1/aai`
 * stays the one import path) purely to keep that module under the file-length
 * cap. They live together because they are only correct together — see each
 * constant's doc, and `resolveEndpointing` in
 * `host/providers/stt/assemblyai.ts`, which is the single place that sends
 * them.
 */

/**
 * Silence (ms) before AssemblyAI streaming STT runs its end-of-turn CHECK
 * (`min_turn_silence`). Endpointing lives in the STT provider, not the
 * transport: disfluent speech (mid-utterance pauses, self-corrections, false
 * starts) would otherwise split one intended utterance across several finals,
 * each committing a turn — the agent answering half the request while the rest
 * is still being spoken, then that same breath barging in and cancelling the
 * reply.
 *
 * **This is not the pause-tolerance knob — {@link DEFAULT_MAX_TURN_SILENCE_MS}
 * is.** On Universal-3.5 Pro the two are different mechanisms. At
 * `min_turn_silence` the model transcribes and asks whether the turn READS as
 * complete: if yes the turn ends, if no a partial is emitted and the turn stays
 * OPEN. Only `max_turn_silence` force-ends regardless of content. So this value
 * is the latency floor on utterances that really did finish — the common case —
 * while a hesitant one is held open by the check itself and bounded by the
 * ceiling.
 *
 * Conflating them cost a release. This was raised 1500 -> 2000 -> 3000 chasing
 * Full-Duplex-Bench v3's "I'm looking for, um, for a new [pause] let me think
 * [pause] a desk", which kept splitting. But `max_turn_silence` defaults to
 * 1536 and was never set, so from 2000 on the minimum EXCEEDED the maximum: the
 * completeness check could not fire before the content-blind force-end had
 * already closed the turn. Every ending came from the acoustic fallback, which
 * is the mechanism that splits utterances — the 2000 step plausibly made
 * splitting worse rather than better, and 3000 changed nothing at all. It also
 * taxed every complete utterance ~3s for a protection it was not buying.
 *
 * **The two knobs guard OPPOSITE splits, and this one must clear a DICTATION
 * pause.** A minimum too low splits a multi-sentence utterance — "How many
 * options do you have? Also, I want to return three items." — because the first
 * sentence genuinely reads complete, so the check ends the turn at the question
 * mark and the agent answers half the request. Worse, it splits a caller
 * spelling something: "Y, U, S, U, F." carries terminal punctuation from the
 * ASR, so a fragment of a spelled name READS complete and the turn ends
 * mid-entity. A maximum too low splits a hesitant utterance, which never reads
 * complete. So this value must clear the pause a speaker leaves between
 * sentences and between dictated characters, while the ceiling clears the pause
 * left WITHIN one continuous thought.
 *
 * **1600 is measured, not chosen.** At 1000 this regressed tau2-bench retail
 * hard: DB reward 1.00 -> 0.40 across the same five tasks, while NL assertions
 * went UP (0.60 -> 0.80) — the agent talked better and acted worse, because it
 * was authenticating against truncated names. Instrumenting the failing run,
 * the pauses INSIDE one user utterance were 856, 917, 927, 941, 946, 972, 973,
 * 991, 993, 1024, 1026, 1050, 1066, 1087, 1172, 1328 and 1455 ms: nine of the
 * eighteen clear 1000, and none clear 1536. The caller spelled their name,
 * it landed truncated, they spelled it again, and then gave up — so no auth, no
 * returns, and an unchanged database. 1600 sits above the observed 1455 ms
 * worst case with a little margin. AssemblyAI documents exactly this
 * ("raise `min_turn_silence` when brief pauses end turns too early, for example
 * while a caller dictates a phone number"); the 1000 floor in
 * `pipeline-transport-options.test.ts` is a floor, not a target.
 *
 * That also rules out AssemblyAI's `mode` preset values (128 / 128 / 800): even
 * `max_accuracy` is tuned for clean dictation into a mic, not for a phone
 * caller who strings sentences together and spells identifiers mid-thought.
 *
 * The cost is real and paid by every finished utterance, so do not raise this
 * further without a measurement — reach for {@link DEFAULT_MAX_TURN_SILENCE_MS}
 * instead, which only bills the utterances that need it.
 *
 * ---
 *
 * **Re-confirmed at 1600 against AssemblyAI's NEW endpointer.** The service
 * shipped an endpointing change, which invalidated the premise of everything
 * above (those failures were the semantic completeness check firing
 * mid-spelling, so a change to how that check decides can move the knee). It
 * was briefly dropped to 800 to retest, then restored on direct evidence.
 *
 * The two tau2-bench retail runs differ ONLY in the endpointer — `sandbox`
 * carries the new one, `default` does not — so aligning every committed STT
 * final to its gold utterance (`user_labels.txt`) A/Bs the models at an
 * identical 1600, offline, over 549 substantive utterances:
 *
 * | endpointer | clean | SPLIT | MERGED | balance |
 * | --- | --- | --- | --- | --- |
 * | old (`retail-stt-default-1031`) | 72% | 12.5% | 8.6% | +10, split-heavy |
 * | new (`retail-stt-sandbox-1031`) | 73% |  9.9% | 8.9% | +3, balanced |
 *
 * So the new model splits 21% less at the same window and the error is now
 * SYMMETRIC — which is the signature of sitting at the knee. That is the whole
 * argument: the knee moved DOWN (the old model wanted a longer window at 1600;
 * this one does not), but it moved modestly, and 1600 is now near-optimal
 * rather than too long. Halving it to 800 pushes hard into split-dominated
 * error, and splits are the expensive direction — a split truncates a spelled
 * identifier so the tool call authenticates against a fragment, while a merge
 * keeps every word and costs only latency. Both error classes land on the same
 * content (spelled emails and names); moving this knob only chooses which one
 * you get.
 *
 * `scripts/voice-replay/` CANNOT settle this knob — it declares no tools and
 * scores no database, so the regression (truncated auth arguments: NL
 * assertions rise while DB match collapses) is invisible to it. The instrument
 * that produced the table above is gold-utterance alignment over an archived
 * run's `task.log`; reach for that, or for reward.
 *
 * ---
 *
 * **CURRENTLY 800, AGAINST THE EVIDENCE ABOVE — set deliberately, UNVERIFIED.**
 * Everything above argues for 1600 and was measured, most recently by the
 * gold-utterance A/B in the table. 800 is a product decision to buy latency at
 * the cost of splits; it is not a measurement, and it is the value that A/B
 * predicts will be split-dominated.
 *
 * The specific risk, from the numbers already recorded above: intra-utterance
 * pauses inside FAILING utterances measured 856-1455 ms, nine of eighteen of
 * them above 1000. At 800 essentially every one of those ends the turn, which
 * is the mechanism that truncates a spelled name or email mid-identifier — so
 * the tool call authenticates against a fragment. Expect NL assertions to hold
 * or rise while DB match falls; that divergence is the signature, and it is
 * invisible to any harness that scores no database.
 *
 * Validate on tau2 reward or on tool-argument accuracy against
 * `evaluation_criteria.actions`. If it does not hold, the value to return to
 * is 1600.
 */
export const DEFAULT_MIN_TURN_SILENCE_MS = 800;

/**
 * Maximum silence (ms) before AssemblyAI force-ends a turn regardless of
 * content (`max_turn_silence`). This is the pause-tolerance knob: it bounds
 * only utterances that never read as complete, so raising it is paid for by
 * hesitant speech alone and costs an ordinary finished sentence nothing —
 * unlike {@link DEFAULT_MIN_TURN_SILENCE_MS}, which taxes every turn.
 *
 * 3500 keeps the ~3s of pause tolerance the 3000 `min_turn_silence` was
 * reaching for, with headroom, and applies it where it actually lands. The
 * service default is 1536, which is what silently governed every turn while
 * the minimum sat above it — so this, not the minimum's nominal 3000, is the
 * number the hesitation failures were actually measured against, and moving
 * 1536 -> 3500 is the whole of the split fix.
 *
 * **CURRENTLY 1600, down from 3500 — set deliberately, UNVERIFIED.** Two
 * consequences of that, both departures from what is argued above:
 *
 * First, 1600 is a hair over the service's own 1536 default, so it very nearly
 * restores the state this constant was introduced to escape: the paragraph
 * above records that 1536 "silently governed every turn" and that moving it to
 * 3500 "is the whole of the split fix". Pause tolerance for hesitant speech is
 * therefore back to roughly what it was before that fix.
 *
 * Second, it no longer exceeds {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS}
 * (2000) — it is now BELOW it, inverting the coupling described above. A
 * barge-in on an utterance that never reads complete now has that utterance
 * force-ended at 1600 ms, BEFORE the 2000 ms recovery window elapses, so the
 * window no longer finds an open utterance to defer against
 * (`host/transports/pipeline-recovery.ts`). The deferral path that made the
 * old ordering safe is simply not reached; the resume proceeds instead. That
 * is a behaviour change, not a tuning change, and it is the one to look at
 * first if false-interruption recovery starts misbehaving.
 */
export const DEFAULT_MAX_TURN_SILENCE_MS = 1600;
