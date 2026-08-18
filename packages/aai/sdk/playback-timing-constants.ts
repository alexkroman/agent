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
 * That asymmetry is real and is why they are two numbers rather than one. What
 * is NOT legitimate is the two disagreeing about the delay itself, which is what
 * happened: the second was a literal 750 decomposed from the playback worklet's
 * startup fill target, a constant that turned out to be redundant and no longer
 * exists. Measured against a recorded reply
 * (`aai-ui/worklets/playback-tuning.test.ts`), the delay is set by the SERVER's
 * pacing rather than by anything on the client — so one of them is derived from
 * the pacer now, and the other carries a note saying it is not yet.
 *
 * Split out of `constants.ts` (which re-exports them, so `@alexkroman1/aai`
 * stays the one import path) when that file hit its length cap; the seam is this
 * pairing rather than an arbitrary cut.
 *
 * @internal
 */

import { CLIENT_AUDIO_LEAD_MS, PACER_BURST_MS } from "./client-audio-constants.ts";

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
 * **That counterpart is now DERIVED from the pacer and this one is not, which is
 * the last un-derived copy of this quantity.** The delay was measured at
 * `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2` (~950 ms at the shipped pacing,
 * `aai-ui/worklets/playback-tuning.test.ts`), so this 750 is ~200 ms short — and
 * it is the reason `CLIENT_AUDIO_LEAD_MS` has NOT been raised despite that being
 * free on the audio side: at a 1500 ms lead the real delay is ~1450 ms and a
 * barge-in in the reply's tail would fall outside this window. Raising it is a
 * change to barge-in behaviour and wants its own measurement, which the bench
 * above does not do — it measures buffer depth, not barge-in outcomes.
 *
 * @internal
 */
export const PIPELINE_PLAYBACK_GRACE_MS = 750;

/**
 * How far BEHIND the server's "audio forwarded" bookkeeping the caller's ear
 * actually is (pipeline mode). Subtracted from the estimated playback position
 * to get the heard cursor — the character of the reply the caller had heard
 * when a barge-in cut it — which decides both what an interrupted turn records
 * in history and where the resume prompt's anchor sits (`pipeline-heard.ts`).
 *
 * **It is DERIVED FROM THE PACER, and that is a correction.** It used to be the
 * literal 750, decomposed as `PLAYBACK_JITTER_MS` (400) plus an assumed
 * sub-second network hop — and both halves were wrong. The cushion the client
 * holds is not the worklet's fill target but the pacer's LEAD, because TTS
 * synthesizes ~20x faster than it plays and the pacer front-loads: measured
 * against a recorded reply (`aai-ui/worklets/playback-tuning.test.ts`), the
 * client's buffer sits at `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2`, moving
 * one-for-one with the lead (848 ms at 1000/200, 1456 ms at 1500/100, 1947 ms at
 * 2000/100) and by under 100 ms across the whole range of the fill target. The
 * term it was derived from turned out to be redundant and no longer exists.
 *
 * So the two are the same physical quantity seen from the two ends of the wire,
 * and the expression is what keeps them from being tuned apart — raising the lead
 * for stall resilience used to silently invalidate this number, in the direction
 * that RECORDS WORDS THE CALLER NEVER HEARD. At the shipped pacing that error was
 * ~130 ms, roughly two words.
 *
 * **The one-way network hop is deliberately NOT added back.** The old assumed
 * ~350 ms of it was a guess, and the closed loop that would price it already
 * exists: `pipeline-heard.ts` consumes the client's own `playback_progress`
 * reports and clamps the playout-end estimate upward with them. Deriving this
 * term from those reports too is the remaining work; until then the formula is at
 * least wrong in a direction that moves with its cause.
 *
 * **It is a SECOND constant rather than a reuse of that grace, deliberately.**
 * The grace is added to a deadline where erring late is harmless (a spurious
 * barge-in cancel flushes an already-empty client buffer), so it may be tuned
 * generously for barge-in robustness. This one is SUBTRACTED from a position
 * where erring either way costs — too large drops words the caller really
 * heard, too small records words they never did — so tuning the grace must not
 * silently change what the record says. Both docs name each other.
 *
 * @internal
 */
export const HEARD_AUDIO_LAG_MS = CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2;
