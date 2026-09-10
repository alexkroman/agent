// Copyright 2026 the AAI authors. MIT license.
/**
 * The two barge-in gates, and why they are two.
 *
 * Split out of `constants.ts` when that file reached the source-length cap, and
 * re-exported from it so no import moved. A module of their own is the right
 * seam rather than an arbitrary one: these two are the whole of pipeline
 * mode's "may the caller interrupt" decision, they were both measured in the
 * same week, and each carries the negative result of moving the other.
 *
 * They are NOT two dials on one axis, which is the mistake to avoid:
 *
 * - {@link DEFAULT_MIN_BARGE_IN_WORDS} asks whether a fragment can interrupt
 *   AT ALL. Lowering it to 1 fixed identifier truncation, because the caller's
 *   one-word give-up probe could not interrupt at 2.
 * - {@link DEFAULT_INTERRUPTION_MIN_DURATION_MS} asks whether a short
 *   utterance was an interruption or an ACKNOWLEDGEMENT. Lowering it broke
 *   backchannels, because once the word count is 1 nothing else answers that.
 *
 * Move them independently, and only ever with the metric that catches the
 * other one's failure in hand.
 *
 * @module
 */

/**
 * Minimum number of words in an interim STT transcript before a barge-in
 * aborts the agent's in-flight turn (pipeline mode). Default 2 so a single
 * word — a backchannel ("mm-hmm", "yeah"), a cough transcribed as one token,
 * or the leading fragment of the user's own turn — does NOT cut the agent off
 * mid-sentence. Sub-threshold utterances are not lost: they are still
 * transcribed and answered once the current reply finishes (see onSttFinal).
 * Set to 1 to restore interrupt-on-any-word.
 *
 * **The known cost of 2 is that "Hello?" cannot interrupt.** On a tau2-bench
 * retail run the worst yield failure of the whole run was a caller's one-word
 * "Hello?" — the give-up probe of somebody who thinks the line is dead — after
 * which the agent held the floor for **12.8 seconds**: no interim barge-in can
 * fire at a threshold of 2, and no final ever committed for that fragment.
 *
 * **1 since 2026-09-09, and what settled it was counting the one-word
 * utterances.** Setting 1 was tried once before inside a four-knob bundle and
 * reverted the same day — agent speech per call roughly halved (746 -> 356
 * speaking chunks), the yield rate went 33% -> 0%, reward 0.25 -> 0.00 — but
 * that bundle also turned `resumeFalseInterruption` off, which removes the
 * recovery that makes an aggressive threshold survivable, and four
 * simultaneous changes cannot be attributed to one.
 *
 * The evidence for moving it is that on tau2-bench retail the caller's
 * GIVE-UP PROBE — "Hello?", "You there?", "Any update?" — runs at **2.4-2.6
 * per call**, and five of six truncated utterances that survived every other
 * fix were probes. A probe is one word. At a threshold of 2 no interim
 * barge-in can fire for one, and a fragment that short frequently never
 * commits a final either, so nothing in the session is left to stop the reply:
 * measured worst case, the agent held the floor **12.8s** after a caller's
 * "Hello?".
 *
 * That is the shape of the problem: the most frequent utterance in these calls
 * is the one utterance the agent was structurally deaf to. It is also the one
 * that matters least to transcribe and most to react to.
 *
 * The cost this accepts is unchanged and real — a one-word backchannel can now
 * abort a reply. What makes it survivable is
 * {@link DEFAULT_INTERRUPTION_MIN_DURATION_MS} still gating on sustained
 * speech, and `resumeFalseInterruption` (left at its `true` default this time)
 * resuming a reply aborted by a partial that never commits. The instrument
 * that would catch this going wrong is the tau-voice S_BC selectivity metric,
 * which had 0-1 events in every run behind these numbers — so it is
 * UNMEASURED, not passed. Raise this back to 2 if S_BC drops on a sample with
 * enough backchannels to read, and watch agent speech per call as the proxy in
 * the meantime.
 */
export const DEFAULT_MIN_BARGE_IN_WORDS = 1;
/*
 * **500, and an attempt at 250 was REVERTED the same day.** With
 * {@link DEFAULT_MIN_BARGE_IN_WORDS} at 1 this window is the only thing
 * standing between the agent and a one-word backchannel, and halving it removed
 * that protection: on tau2-bench retail, backchannel selectivity (tau-voice
 * S_BC) fell from 4/4 correct across six runs to **1 of 3**, while case-(b)
 * truncations went 0.4-0.6 -> 1.2/call, give-up probes 1.8-2.6 -> 3.2/call, and
 * the >3s endpointing tail 12-20% -> 25%.
 *
 * The reasoning behind the attempt was that ~470ms to the STT's first partial
 * plus 500ms here is ~970ms against a caller who abandons a sentence after
 * ~1.0s, so the window looked like the binding constraint on yield speed. It
 * is the binding constraint — and it is load-bearing anyway. This is NOT
 * latency overhead; it is the filter that decides whether a short utterance was
 * an interruption or an acknowledgement, and nothing else in the pipeline
 * answers that question once the word count is 1.
 *
 * **The other half of the 970ms was attacked too, and failed worse.** The
 * ~470ms is the STT's own time to a first partial, and the host already holds
 * the PCM it forwards, so a local detector can answer "somebody is talking" in
 * tens of milliseconds. One was built and swept against ground truth from
 * captured call audio: 96% onset recall at 64ms latency, and it made everything
 * worse — ~24 ducks per call, agent speech per call 946 -> 568 characters, and
 * give-up probes UP from 2.4 to 3.4, because a caller who never hears a
 * complete sentence asks "are you still there?" more often, not less. A neural
 * detector did not rescue it: silero-vad's whole Pareto front was dominated on
 * this signal, band-limited 8kHz mu-law being outside its training
 * distribution.
 *
 * So the transcript path's floor buys SELECTIVITY rather than merely costing
 * latency, and onset recall is the wrong objective: what matters is whether the
 * caller is TAKING THE FLOOR, which is a judgement about words. Both halves of
 * that 970ms have now been measured and both are load-bearing.
 */
export const DEFAULT_INTERRUPTION_MIN_DURATION_MS = 500;
