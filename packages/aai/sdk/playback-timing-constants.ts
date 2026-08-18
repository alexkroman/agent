// Copyright 2026 the AAI authors. MIT license.

/**
 * The two constants that model ONE physical delay: how long it is between the
 * server handing a TTS frame to the socket and the caller hearing it.
 *
 * They live together because they are the same quantity with opposite signs, and
 * keeping them apart is what let them drift:
 *
 * - {@link PIPELINE_PLAYBACK_GRACE_MS} is ADDED to a deadline, asking "could
 *   anything still be audible?" — so erring late is harmless.
 * - {@link HEARD_AUDIO_LAG_MS} is SUBTRACTED from a position, asking "where had
 *   the voice actually got to?" — so erring in either direction costs, because
 *   it decides what an interrupted reply records in history.
 *
 * That asymmetry is real and is why they are two numbers rather than one.
 *
 * **What they have in common is the trap.** Both are applied on top of the
 * playback clock in `pipeline-heard.ts`, whose `endsAtMs` already tracks how much
 * forwarded audio the client has not played — so neither of them is the client's
 * buffer depth, and sizing either one against that depth double-counts it. Both
 * were sized that way at some point, and the second one twice. What is left for
 * each is the residual the host cannot see: the network hop, and the client's
 * fill target. Measured against a recorded reply
 * (`aai-ui/worklets/playback-tuning.test.ts`), that residual is tens of
 * milliseconds and does not move with the pacer's lead at all.
 *
 * Split out of `constants.ts` (which re-exports them, so `@alexkroman1/aai`
 * stays the one import path) when that file hit its length cap; the seam is this
 * pairing rather than an arbitrary cut.
 *
 * @internal
 */

/**
 * Slack added to the pipeline transport's estimated client playback deadline
 * when deciding whether user speech is a barge-in. The estimate assumes each
 * forwarded TTS chunk starts playing the instant it is sent, so real playback
 * always ends a little later (network latency + client jitter buffer); the
 * grace keeps barge-in working through that tail. A spurious cancel inside
 * the window is harmless — the client flushes an already-empty buffer.
 *
 * **Its counterpart with the opposite sign is {@link HEARD_AUDIO_LAG_MS}**,
 * which models the same physical delay (network + jitter buffer) but is
 * SUBTRACTED, to ask "where had the voice actually got to" rather than "could
 * anything still be audible". The harmlessness argument above does NOT transfer
 * to it: that one decides what an interrupted reply records in history, where
 * erring in either direction costs. Tune this one for barge-in robustness
 * without assuming the other should follow.
 *
 * **750 is generous, it does NOT need to scale with the pacer, and both of those
 * are measured.** The requirement is how long after `endsAtMs` the caller is
 * still hearing audio, and `aai-ui/worklets/playback-tuning.test.ts` measures it
 * by driving the real worklet: **15 ms on a loopback link, 63 ms on a typical
 * one, 138 ms on a mobile one** — and identical at pacer leads of 1000, 1500 and
 * 2000 ms, because `endsAtMs` accumulates from `max(endsAtMs, now())` and so
 * already tracks the lead. What is left is the client's fill target plus the hop.
 *
 * It was briefly believed that this constant was ~200 ms SHORT and that it
 * therefore blocked raising `CLIENT_AUDIO_LEAD_MS`. That was wrong in the
 * same way the old {@link HEARD_AUDIO_LAG_MS} derivation was wrong — it compared
 * the constant against the client's buffer depth, which the playback clock
 * already accounts for. The margin here is ~5x the worst measured requirement,
 * and the lead is not coupled to it.
 *
 * @internal
 */
export const PIPELINE_PLAYBACK_GRACE_MS = 750;

/**
 * How far BEHIND the server's "audio forwarded" bookkeeping the caller's ear
 * actually is (pipeline mode), OVER AND ABOVE what the playback clock already
 * accounts for. Subtracted from the estimated playback position to get the heard
 * cursor — the character of the reply the caller had heard when a barge-in cut it
 * — which decides both what an interrupted turn records in history and where the
 * resume prompt's anchor sits (`pipeline-heard.ts`).
 *
 * **"Over and above" is the whole of it, and two successive derivations got it
 * wrong by ignoring that clause.** `heardMs()` is
 * `audioMs - clock.remainingMs() - lagMs`, and `remainingMs()` is already the
 * host's estimate of unplayed forwarded audio: `endsAtMs` accumulates each
 * chunk's duration from `max(endsAtMs, now())`, so once the pacer runs ahead the
 * estimate runs ahead with it. **The client's buffer depth is therefore already
 * subtracted**, and anything this constant adds on top is double-counting it.
 *
 * So what is left for this term is the ONE-WAY NETWORK HOP — the only part of the
 * delay the host genuinely cannot see. Measured
 * (`aai-ui/worklets/playback-tuning.test.ts` drives the real worklet and compares
 * the host's arithmetic against the audio the ear actually received): with this
 * term at ZERO the cursor is already accurate to +8 ms on a loopback link, +55 ms
 * on a typical one and +130 ms on a mobile one, and the error is IDENTICAL at
 * pacer leads of 1000, 1500 and 2000 ms. 150 makes the residual non-positive on
 * all three, which is the required direction: the roundings in `pipeline-heard.ts`
 * all err toward UNDER-keeping.
 *
 * **The two wrong derivations, because both are instructive.** It was a literal
 * 750, decomposed as the playback worklet's old startup fill target (400) plus an
 * assumed sub-second hop — which double-counted the buffer and left the cursor
 * ~694 ms EARLY on a typical link. That is ~10 words at English narration rates,
 * not the "word or two of redundancy" the asymmetry argument budgets for, and it
 * pushes in exactly the direction of the repetition `buildTailResumePrompt` was
 * built to fix. The first attempt to correct it made the term
 * `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2` on the evidence that the client's
 * buffer holds the pacer's lead — true, and the wrong conclusion, because that
 * depth is what `remainingMs()` already reports. It measured the right quantity
 * and attributed it to the wrong term, taking the error to ~894 ms.
 *
 * The lesson for the next change here: this constant is NOT the client's buffer
 * depth. Measure `heardMs()` against the ear, not the buffer against the lead.
 *
 * @internal
 */
export const HEARD_AUDIO_LAG_MS = 150;
