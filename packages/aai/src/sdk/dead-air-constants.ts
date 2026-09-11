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
 * **Nothing is spoken at t=0, and that is the other half of the design.** A
 * structural bet — "this turn opened with a tool call, so silence is coming" —
 * pays on every such turn regardless of how long the tool actually takes, and
 * the ordinary opening gap is about a second: LLM time-to-first-text measured
 * p50 **1.10s** / mean 1.42s on a tau2-bench retail run. That is a pause, not
 * dead air, and covering it costs the FIRST SENTENCE, which the voice rules
 * spend deliberately (eight words, carrying the answer, because interruption
 * rate climbs with reply length — 17% under 10 words to 59% past 35). Waiting
 * for 5s of MEASURED silence costs a fast turn nothing.
 *
 * **Must stay above the MEDIAN tool turn, not below it.** This is cover for the
 * long-chain outlier; at 2000 it was under the ordinary case and fired on
 * essentially every tool turn instead. Measured on the EVA airline run: tool
 * turns averaged 6.24s, so 2000 fired on 93% of them (`pretoolspeech_rate`
 * 0.933) and twice on the 8.7s and 10.5s turns — turning a latency problem into
 * a verbosity one (`verbosity_or_filler_rate` 0.38,
 * `redundant_statements_rate` 0.60) and, once, derailing the call outright (see
 * {@link DEAD_AIR_COVER_PHRASES}). 5000 sits below the 6.24s mean but above the
 * turns that complete normally, so a routine single tool call now finishes
 * unaccompanied and only a genuine chain draws cover. There is no measured
 * value between 2000 and 5000; do not split the difference by feel.
 *
 * **This number is in the AGENT's frame, and the caller is in another one.**
 * Cover is armed when the turn's LLM stream opens, which is one
 * `minTurnSilenceMs` (1600ms on the default AssemblyAI pipeline) plus commit
 * after the caller stopped speaking — so 5000 here is ~6.7s of measured wait
 * from the caller's side. On a tau2-bench retail run that mattered: the
 * simulated caller re-spoke after 5.0s, **9 of 26 turns (35%) ended that way,
 * every one at exactly 5.2s**, and cover fired zero times in the whole run.
 * A deployment whose caller gives up on a known deadline should subtract its
 * endpointing budget from that deadline rather than reading this number as if
 * the two clocks agreed.
 *
 * **3000, and the instrumentation that justifies it exists now.** Lowering it
 * was tried once before inside a four-knob bundle, showed no response-rate
 * movement, and was reverted — but that bundle also turned
 * `resumeFalseInterruption` off, which halved agent speech per call and would
 * have masked any gain. It was never cleanly tested, and at the time nothing
 * could even confirm a filler had played: they are emitted `record: false`, so
 * they reach TTS and the interim transcript but never a committed one, and no
 * log line announced them.
 *
 * `pipeline-stream-parts.ts` logs every firing now (phrase, `opening`,
 * `coverCount`, and the window actually armed), and that turned the argument
 * from inference into arithmetic. Measured on a tau2-bench retail run: cover
 * fired 5 times across 5 calls, **every one of them `opening: true` at
 * `waitedMs: 5000`** — the right turns, and too late on all of them. Against
 * a simulated caller who gives up after 5.0s:
 *
 *     caller stops                                  t = 0
 *     endpointing (min_turn_silence 1600) + commit  ~1.8s   <- cover's clock starts
 *     caller gives up and asks "are you still there" t = 5.0s
 *     earliest possible filler at 5000              ~6.8s
 *
 * The probe wins by ~1.8s every time, so cover could not pre-empt a single one.
 * 3000 puts the filler at ~4.8s, just inside the deadline. Five of six residual
 * truncations in that run were give-up probes, and two carried audible agent
 * speech with NO transcript text — the filler's signature, i.e. the probe
 * colliding with the very filler meant to prevent it.
 *
 * **UNDER TEST at 2000, because 3000 fixed the mechanism without moving the
 * outcome.** At 3000 cover really did fire in time — 8 firings at
 * `waitedMs: 3000` plus 3 backed off to 6000, a 20% fire rate across 56 turns,
 * nowhere near the 93% that condemned 2000 on EVA — and give-up probes per call
 * did not fall (2.4 -> 2.6). The likely reason is margin: 1.8s of endpointing
 * plus 3.0s puts the filler at ~4.8s against a 5.0s deadline, and a caller
 * decides to probe BEFORE it starts speaking, so 200ms of headroom is probably
 * less than the decision itself takes. 2000 puts the filler at ~3.8s, a 1.2s
 * margin.
 *
 * The 93% objection is measured on a DIFFERENT workload and may not transfer:
 * EVA airline tool turns averaged 6.24s, while on the tau2 retail run behind
 * these numbers only 16% of turns exceed 2000ms (single-step turns are p50
 * 971ms, max 1981ms). If the fire rate here comes in near that 16-20% rather
 * than 93%, the verbosity argument does not apply at this value on this
 * workload. If probes still do not fall at 2000, the hypothesis that cover can
 * pre-empt them is wrong and this should go back to 5000.
 *
 * Authors override it with `deadAirCoverMs`; 0 disables cover entirely.
 *
 * @internal
 */
export const DEFAULT_DEAD_AIR_COVER_MS = 5000;

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
 * waiting long enough to be sure — and 5000 ms from turn commit is ~6.7 s in
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
