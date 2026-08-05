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
 */
export const DEFAULT_MIN_TURN_SILENCE_MS = 1600;

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
 * Note this EXCEEDS {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS} (2000) even
 * though the minimum no longer does, so the recovery-window coupling survives
 * in narrowed form: a barge-in on an utterance that never reads complete still
 * has its window elapse before its own final. That stays safe for the same
 * reason as before — a fired window whose utterance is still open merely
 * DEFERS the resume (`host/transports/pipeline-recovery.ts`) — and the case is
 * now exactly the one where the caller is still audibly mid-sentence, which is
 * what the deferral tests for.
 */
export const DEFAULT_MAX_TURN_SILENCE_MS = 3500;
