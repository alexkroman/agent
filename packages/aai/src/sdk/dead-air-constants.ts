// Copyright 2026 the AAI authors. MIT license.
/**
 * Dead-air cover: the phrases, and the three windows that decide WHEN one is
 * spoken.
 *
 * Split out of `pipeline-tuning-constants.ts` at the 500-line cap, along the
 * seam that file already had — these five constants are one mechanism, they
 * are read together by `pipeline-stream-parts.ts`, and nothing else in the
 * tuning file touches them. Re-exported from there so no import moved.
 *
 * The mechanism in one sentence: a turn that has gone quiet gets a filler,
 * and which window it waits depends on whether the turn has ANNOUNCED that it
 * is about to go quiet — see {@link DEAD_AIR_TOOL_COVER_MS} versus
 * {@link DEFAULT_DEAD_AIR_COVER_MS}. Filler is deliberately not "speech": it
 * is sent `record: false` and does not open the barge-in gate, without which
 * a caller talking over a holding phrase destroys the reply behind it (see
 * `HeardTracker.spokeRecordable`).
 */

/**
 * Fillers cycled through while a tool chain keeps the line silent, in order.
 *
 * Distinct from {@link DEAD_AIR_OPENING_PHRASE} and from each other because the
 * gap they cover repeats: one phrase six times reads as a stuck loop, which
 * is its own kind of broken. The wait between them backs off exponentially, so
 * a long chain thins out rather than chattering.
 *
 * **Every phrase must be purely declarative — a status report, never a request
 * for patience.** Filler is spoken into an open microphone, so anything that
 * asks something of the caller gets ANSWERED, and the answer costs a turn the
 * conversation then has to unwind. Measured on EVA airline record 1.1.2: the
 * agent emitted "Still working on that.", the caller replied "All right, I'll
 * hold" — which barged in, since it clears `DEFAULT_MIN_BARGE_IN_WORDS` — the
 * resume replayed the interrupted sentence verbatim, and the agent was still
 * answering "I'll hold" ("There is no need to hold; the change is complete")
 * two turns later, after the caller had said goodbye. One filler cost a wasted
 * turn, a redundant repetition, and two turns of desync.
 *
 * "Still working on that" and "Just a moment longer" both read as asking the
 * caller to wait. The replacements state what is happening and stop.
 *
 * @internal
 */
export const DEAD_AIR_COVER_PHRASES: readonly string[] = [
  "I'm still checking on this.",
  "This is taking a little longer than usual.",
  "I'm still on it.",
];

/**
 * The filler spoken when the gap being covered is the turn's OPENING one —
 * nothing has reached the caller yet this turn.
 *
 * A distinct phrase rather than element 0 of {@link DEAD_AIR_COVER_PHRASES}
 * because that one is "I'm still checking on this.", which implies work the
 * caller already heard narrated, and here it would be the very first words of
 * the turn. Every later gap in the turn follows something the model said, so
 * the cycle's wording fits there and not here.
 *
 * **The wording is a JUDGEMENT CALL, not a measurement.** What is measured is
 * the constraint it satisfies: the phrase must be purely declarative and never
 * a request for patience (see {@link DEAD_AIR_COVER_PHRASES} for the EVA 1.1.2
 * record of what a request costs). "One moment." — the incumbent hold phrase,
 * retired with that mechanism — reads as a request for patience by that same
 * rule, which is why this is not simply that string moved. A measurement
 * comparing openers is worth running and has not been.
 *
 * @internal
 */
export const DEAD_AIR_OPENING_PHRASE = "I'm checking on this.";

/**
 * How long a pipeline turn may send nothing to TTS before the transport speaks
 * filler — {@link DEAD_AIR_OPENING_PHRASE} for the turn's opening gap,
 * {@link DEAD_AIR_COVER_PHRASES} for every gap after the model has spoken.
 *
 * The gap this exists for is the LONG one. A model that says "Let me look that
 * up" and then chains six tool calls goes silent for as long as the chain takes
 * — measured at 15-24s against the tau2-bench retail tasks, well past the point
 * a caller assumes the line is dead — and a turn can be silent before its first
 * token too: 31.4s after a committed user turn on tau2-bench retail with
 * gpt-5.5, ended only by the first tool call (see the construction-time arm in
 * `pipeline-stream-parts.ts`). Cover is time-based, so both are the same case:
 * any gap this long gets filler, whether or not the model already spoke.
 *
 * **Nothing is spoken at t=0.** The ordinary opening gap is about a second:
 * LLM time-to-first-text measured p50 **1.10s** / mean 1.42s on a tau2-bench
 * retail run. That is a pause, not dead air, and covering it costs the FIRST
 * SENTENCE, which the voice rules spend deliberately (eight words, carrying the
 * answer, because interruption rate climbs with reply length — 17% under 10
 * words to 59% past 35). Waiting for 2.4s of MEASURED silence still lets a
 * normal reply start before any filler.
 *
 * **2400 is the tool window's first firing, applied to every turn.** A turn
 * whose first tool call lands at the measured p50 (~1.2s, see
 * {@link DEAD_AIR_TOOL_COVER_MS}) hears its filler 1.2s later, at ~2.4s into
 * the turn. This window used to be 5000, so a turn that went quiet WITHOUT a
 * tool call — a stalled first token, a long reasoning phase — waited more than
 * twice as long for the same reassurance. Matching the two puts every silent
 * turn's first filler at the same point, whatever made it silent.
 *
 * **This number is in the AGENT's frame, and the caller is in another one.**
 * Cover is armed when the turn's LLM stream opens, which is one
 * `minTurnSilenceMs` (1600ms on the default AssemblyAI pipeline) plus commit
 * after the caller stopped speaking — so 2400 here is ~4.0-4.2s from the
 * caller's side. That is inside the 5.0s after which a simulated tau2-bench
 * caller re-speaks ("are you still there?"); at 5000 it was ~6.7s and lost to
 * that probe on every firing (5 of 5 on one retail run, 113 of 123 on a
 * 114-task run, all `opening: true` at `waitedMs: 5000`).
 *
 * **What this costs, measured at neighbouring values.** On EVA airline, where
 * tool turns averaged 6.24s, a 2000 base fired on 93% of tool turns
 * (`pretoolspeech_rate` 0.933) and raised `verbosity_or_filler_rate` to 0.38 —
 * but tool turns are now covered by {@link DEAD_AIR_TOOL_COVER_MS} at 1200
 * anyway, so this base decides only the turns that make NO tool call. On tau2
 * retail, single-step turns are p50 971ms, max 1981ms, and 16% of all turns
 * exceed 2000ms. Lowering the base to 3000 and 2000 there fired the cover in
 * time without reducing give-up probes per call (2.4 -> 2.6 at 3000). 2400 was
 * chosen to line up with the tool window, not measured on its own; check the
 * `Pipeline dead-air cover` log's fire rate at `waitedMs: 2400` before moving
 * it again.
 *
 * Authors override it with `deadAirCoverMs`; 0 disables cover entirely.
 *
 * @internal
 */
export const DEFAULT_DEAD_AIR_COVER_MS = 2400;

/**
 * Ceiling on the dead-air cover's exponential backoff, so a long tool chain
 * settles into a steady heartbeat instead of drifting into silence.
 *
 * Uncapped doubling from {@link DEFAULT_DEAD_AIR_COVER_MS} put the fillers of a
 * 90s chain at 0, 2, 6, 14, 30 and 62s — gaps of 2, 4, 8, 16 and 32s. Net of
 * each phrase's own ~1.3s of audio that is roughly 0.7s, 2.7s, 6.7s, 14.6s and
 * 30.6s of actual silence: two fillers almost on top of each other at the start,
 * and then gaps well past the point where the caller concludes the line is dead
 * — reintroducing, at the tail of exactly the long chains it exists for, the
 * dead air the mechanism is there to cover. Measured against the tau2-bench
 * retail runs, whose 45s tool chains ended with a silent 15s stretch.
 *
 * At 8000 the same chain reassures roughly every 6.5s of silence once it has
 * ramped, which is the cadence a human on a phone keeps ("bear with me…"),
 * while the ramp still keeps a short chain from chattering.
 *
 * @internal
 */
export const DEAD_AIR_COVER_MAX_MS = 8000;

/**
 * Cover window armed by a `tool-call` stream part, rather than by the turn
 * opening — short, because by the time a tool call is emitted the silence is
 * no longer a guess.
 *
 * {@link DEFAULT_DEAD_AIR_COVER_MS} is armed when the turn's stream opens, a
 * condition true of EVERY turn, so it can only distinguish the silent ones by
 * waiting long enough to be sure — and at its old 5000 ms that was ~6.7 s in
 * the caller's frame, past the point a caller concludes the line is dead.
 * Measured on a 114-task tau2-bench retail run: **123 firings across 1076
 * turns, 113 of them `opening: true` at exactly `waitedMs: 5000`** — the right
 * turns, too late on every one. Lowering the BASE instead was tried at 3000
 * and 2000 and moved no outcome, because it also fires on the 67% of turns
 * that were about to answer anyway.
 *
 * A `tool-call` part is the better condition: true of exactly the turns that
 * go quiet, and early. Over 364 tool-calling turns the first call lands at
 * **p50 1183 ms** and the silence from there to the answer is **p50 2220 ms,
 * p90 8800 ms**. 1200 puts the filler ~2.4 s into the turn, ~4.0 s in the
 * caller's frame at the default 1600 ms endpointing — inside the 5.0 s a
 * caller waits before concluding the line is dead, and still long enough that
 * a chain returning promptly says nothing.
 *
 * **This is only safe because filler no longer opens the barge-in gate.**
 * Firing the cover three times sooner means three times the opportunity for a
 * caller to talk over a holding phrase, and until `HeardTracker.spokeRecordable`
 * that cancelled the real reply behind it. Do not shorten this window again
 * without checking that predicate still holds.
 *
 * `deadAirCoverMs: 0` disables cover entirely and disables this with it.
 *
 * @internal
 */
export const DEAD_AIR_TOOL_COVER_MS = 1200;
