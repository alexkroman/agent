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
 * **The floor is 1000 and the two knobs guard OPPOSITE splits.** A minimum too
 * low splits a multi-sentence utterance — "How many options do you have? Also,
 * I want to return three items." — because the first sentence genuinely reads
 * complete, so the check ends the turn at the question mark and the agent
 * answers half the request. A maximum too low splits a hesitant one, which
 * never reads complete. So this value must clear the pause a speaker leaves
 * BETWEEN two sentences, while the ceiling must clear the pause left WITHIN
 * one. `pipeline-transport-options.test.ts` pins the 1000 floor.
 *
 * That rules out AssemblyAI's `max_accuracy` preset value of 800 (the presets
 * set 128 / 128 / 800), which is tuned for dictation rather than for a caller
 * who strings sentences together. 1000 is the floor with no margin above it on
 * purpose: every ms here is paid by every finished utterance, and the pause
 * this has to clear is the one case that justifies the cost.
 */
export const DEFAULT_MIN_TURN_SILENCE_MS = 1000;

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
