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
 *
 * ## Four findings that are NOT re-derivable, moved out of the guide
 *
 * `packages/aai/CLAUDE.md` carried these in its defaults table until that guide
 * hit its 120,000-character cap. They are archive rather than rule — each is a
 * run already decided by — so the guide keeps the rule and points here.
 *
 * **Do not tune the minimum from a pause histogram.** The intra-utterance pause
 * distribution over the same runs is p99 **593 ms**, with 1 gap in 1037 above
 * 1200 ms, which argues for 800 and is the wrong instrument: percentiles describe
 * what an ACOUSTIC endpointer needs, while on U3.5 Pro this is where the SEMANTIC
 * completeness check runs. The failures are "the check fired mid-spelling and the
 * fragment read complete", which no pause distribution predicts.
 *
 * **1600 is the knee, confirmed by a direct sweep** — 600/800/1200/1400/1600/1800/
 * 2000 ms over 4 replayed sessions with Voice Focus at 0.9. Below 1600 the
 * transcript over-segments (1.02-1.08x turns per gold utterance) and an auth field
 * is lost: at 1200 the check fires mid-surname, `Last name K-O-V-A-C-S` becomes
 * two fragments and `kovacs` never lands. At and above 1600 it is 0.99x with 12/12
 * auth fields surviving. 1800 scores marginally better on every axis except p50
 * latency and is inside the noise for n=4 — 1600 is structural, 1800 would be a
 * sample maximum.
 *
 * **Latency does not move with the nominal value.** 600 -> 2000 is a nominal
 * 1400 ms but moves p50 endpoint latency only ~910 ms, and p90 is flat at
 * ~4.0-4.6s at every setting because the tail is content-driven.
 *
 * **`interruption_delay` and `mode` are measured NO-OPS here**, which matters
 * because the docs actively suggest reaching for the first: `interruption_delay=0`,
 * `mode=min_latency` and `mode=max_accuracy` all leave first-partial latency at
 * p50 0.47-0.52s, identical to unset, with no error frame and the parameter
 * accepted. ~470 ms to first partial is a MODEL floor, not a knob — so the only
 * remaining lever on barge-in latency is our own `interruptionMinDurationMs`.
 * (`vad_threshold` is measured and deliberately left alone; see the Voice Focus
 * row in the guide's defaults table for why it loses in both directions.)
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
 * **This is not the pause-tolerance knob — `DEFAULT_MAX_TURN_SILENCE_MS`
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
 * while a caller dictates a phone number"); the 1000 ms the transport's own
 * tests pin is a floor, not a target.
 *
 * That also rules out AssemblyAI's `mode` preset values (128 / 128 / 800): even
 * `max_accuracy` is tuned for clean dictation into a mic, not for a phone
 * caller who strings sentences together and spells identifiers mid-thought.
 *
 * The cost is real and paid by every finished utterance, so do not raise this
 * further without a measurement — reach for `DEFAULT_MAX_TURN_SILENCE_MS`
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
 * A turn-taking-only replay harness CANNOT settle this knob — it declares no
 * tools and scores no database, so the regression (truncated auth arguments: NL
 * assertions rise while DB match collapses) is invisible to it. The instrument
 * that produced the table above is gold-utterance alignment over an archived
 * run's `task.log`; reach for that, or for reward.
 *
 * ---
 *
 * **800 WAS TRIED AND FAILED — measured, on reward.** It was set deliberately
 * against everything above, as a product decision to buy latency at the cost of
 * splits, and the validation run it asked for disproved it. tau2-bench retail,
 * the same 25 tasks at the same seed, differing only in this pair:
 *
 * | run | min / max | reward | mis-heard | split / merged | reached a tool call |
 * | --- | --- | --- | --- | --- | --- |
 * | `retail-stt-default-1248` | 1600 / 3500 | **0.68** | 43% | 23 / 14 (1.6:1) | 15 of 294 (5.1%) |
 * | `retail-stt-default-139` | 800 / 1600 | **0.12** | 52% | 27 / 8 (3.4:1) | 26 of 264 (9.8%) |
 *
 * `retail-stt-default-1031` independently scored 0.68, so that is the stable
 * baseline and 0.12 is a 5.7x regression — 3 of 25 tasks passing against 17.
 * The prediction recorded here held exactly: splits rose ~30% per utterance
 * while merges fell ~37%, moving the error off the knee into the expensive
 * direction, and the rate at which a mis-hearing corrupted a tool argument
 * nearly doubled. Task 1 is the canonical failure — "Yusuf Rossi, zip code one
 * nine one two two" came back as "You'll surprise me. Zip code 19122.", then
 * "Already gave it—Yusuf Rossi" as "Yusuf Rafi", and
 * `find_user_id_by_name_zip.last_name='rafi'` authenticated against a fragment.
 *
 * Two notes on how that was established, both reusable:
 *
 * `scripts/stt_errors.py` in tau2-bench IS the gold-utterance alignment
 * instrument this doc asks for — it aligns greedily over 1:1/1:2/2:1 and reports
 * the CARDINALITY, so a split is a named finding rather than a low similarity
 * score. Do not rewrite it. `scripts/failure_report.py` covers the wire side.
 *
 * And confirm the window was LIVE before believing a null result. Audio time is
 * `tick x 0.2` in tau2's discrete-time adapter and `user_labels.txt` shares that
 * timeline, so gold-utterance-end to `user_transcript` measures what the service
 * actually waited out: median 2.00s at 1600/3500 against 1.20s at 800/1600 (the
 * 0.80s delta is precisely this knob), p90 3.8s against 2.2s (the ceiling). A
 * dev-server restart is what loads a changed constant, and `watchDirectory`
 * ignores `node_modules` — where the linked SDK lives — so an SDK edit mid-run
 * reaches nothing. That cuts both ways: it is why this run is a clean A/B
 * despite three unrelated SDK commits landing inside its window, and it is why
 * a run can silently measure the PREVIOUS value.
 *
 * @see `DEFAULT_MAX_TURN_SILENCE_MS` — the ceiling this floor pairs with.
 * @see `DEFAULT_DEEPGRAM_ENDPOINTING_MS` on `@alexkroman1/aai/stt` — Deepgram
 * endpoints in its own recognizer rather than through these two, so a pipeline
 * fronted by Deepgram is tuned there instead.
 */
export const DEFAULT_MIN_TURN_SILENCE_MS = 1600;

/**
 * Maximum silence (ms) before AssemblyAI force-ends a turn regardless of
 * content (`max_turn_silence`). **This is the pause-tolerance knob**: it bounds
 * only utterances that never read as complete, so raising it is paid for by
 * hesitant speech alone and costs an ordinary finished sentence nothing —
 * unlike `DEFAULT_MIN_TURN_SILENCE_MS`, which taxes every turn.
 *
 * Reach it per agent with `agent({ maxTurnSilenceMs })` on the default pipeline,
 * or on the descriptor directly with `assemblyAIStt({ maxTurnSilenceMs })`.
 *
 * @defaultValue `3500` — the value both measured tau2-bench retail runs scored
 * reward 0.68 at, paired with a 1600 minimum.
 *
 * @remarks
 * **3000 was tried and reverted.** It was a 500 ms trim off the measured pair,
 * deliberate but never measured on its own, carrying an explicit revert
 * condition: *splits reappearing on hesitant, non-spelling utterances while
 * spelled identifiers stay intact*, the asymmetry that distinguishes this
 * ceiling from `DEFAULT_MIN_TURN_SILENCE_MS`. That is precisely what the
 * retail run at 3000 produced (aligning every committed final against its gold
 * utterance with `scripts/stt_errors.py`, 40 of 56 utterances mis-heard). Every
 * split landed on a hesitation, and every one of those hesitations was a
 * non-speech event mid-sentence:
 *
 * - *"…how many T-shirt options are on your online store right now? And second,
 *   I need to change all my pending [sneeze][sneeze][sneeze] T-shirts to
 *   purple…"* — committed after "right now?", the entire second request
 *   dropped, then re-attached to the FRONT of the caller's next, unrelated
 *   turn.
 * - *"Yes—confirm. [sneeze][sneeze][sneeze] Go ahead."* — two finals, so two
 *   independent replies to one act of confirming.
 *
 * Meanwhile the spelled identifiers the floor protects came through whole
 * ("first name Y-U-S-U-F, last name R-O-S-S-I"), which is the other half of the
 * signature and the reason this is the knob that moves rather than the
 * minimum — raising that one would tax every finished utterance for a fault
 * that only hesitant ones have. The record is not that 3500 is optimal; it is
 * that a split does not merely delay a turn, it makes the agent answer half a
 * request and then treat the other half as a new one.
 *
 * **Two orderings this value has to keep.** It stays BELOW
 * `DEFAULT_SPEECH_IDLE_TIMEOUT_MS` (4000, internal) less final-emission
 * latency, so an utterance force-ended by this ceiling still delivers its final
 * before the speaking edge goes idle — and the idle edge is what fires a
 * false-interruption resume (`host/transports/pipeline-recovery.ts`), so
 * crossing that line does not merely delay a turn, it lets the agent resume a
 * reply the caller really did interrupt. 500 ms of margin is thin, which is why
 * raising this to 3500 took `DEFAULT_SPEECH_IDLE_TIMEOUT_MS` to 4000 with it.
 * And it stays clear of the service's own 1536 default, so the ceiling is ours
 * rather than silently the service's — the state this constant was introduced
 * to escape.
 *
 * What the ceiling costs is pause tolerance for hesitant speech, paid ONLY by
 * utterances that never read as complete — which is equally the reason trimming
 * it buys so little. The measured tail is content-driven and long (p90 endpoint
 * latency ~4.0-4.6s at every setting swept), so the ceiling is not what makes a
 * slow turn slow.
 *
 * @see `DEFAULT_MIN_TURN_SILENCE_MS` — the floor this ceiling pairs with.
 * @see `DEFAULT_DEEPGRAM_ENDPOINTING_MS` on `@alexkroman1/aai/stt` — Deepgram has
 * no counterpart to this ceiling; it endpoints on a single silence threshold.
 */
export const DEFAULT_MAX_TURN_SILENCE_MS = 3500;

/*
 * CONFIDENCE-TRIGGERED ENDPOINTING WAS BUILT, MEASURED, AND REMOVED — do not
 * rebuild it without new evidence, and read this first if you are tempted to
 * trim the ceiling instead.
 *
 * The ceiling is content-blind, so an utterance that never reads as complete
 * pays all of it. Measured 2026-08-09 against the live service on a raw v3
 * socket (no SDK in the path), three runs per arm, spread < 0.15 s:
 *
 * | utterance | ceiling 3500 | ceiling 2000 |
 * | --- | --- | --- |
 * | "…the order ID is ABC123." | 22.9 s -> `A A, B, C, 1, 2, 3.` | 18.3 s -> `ABC123.` |
 * | "Um, so like, uh… a desk. Something under $300…" | 23.9 s, whole utterance | 10.3 s -> `"…I'm looking for, um, for a new"` |
 *
 * So trimming the ceiling is NOT available: it buys 4.6 s on the identifier
 * and truncates the hesitant caller before the product or the price — the
 * same failure that reverted a 3000 ceiling above. Note also that the extra
 * wait is not idle; the service spends it re-rendering `ABC123.` into a
 * spelled-out form that acquires a spurious doubled "A", so the ceiling costs
 * transcript quality on identifiers as well as time.
 *
 * The obvious escape is the service's own `ForceEndpoint` driven by
 * `end_of_turn_confidence` — end the turn ourselves once the ramp is high and
 * the transcript has stopped changing. It works, and it is not worth having:
 * across 51 real disfluent utterances (two disjoint samples of FDB-v3 audio,
 * 25 and 26) it fired on 3 of each, saving a median 0.8-1.3 s, with ZERO
 * truncations. The reason it cannot do better is the signal, not the policy:
 * **21 of 26 utterances never emit a single non-zero confidence partial**
 * (peak-confidence distribution 0.0 x21, then 0.52, 0.52, 0.95, 0.97, 0.97).
 * The service only ramps when a pause makes it dither; otherwise the check
 * fires once and the final lands with no intermediate signal. Sweeping the
 * threshold 0.4-0.9 offline against recorded traces changes nothing — the same
 * 3 utterances fire at every level — and relaxing the two-sample plateau to one
 * sample introduces real truncations at 0.5 and below. Ceiling of ~12% of
 * turns and ~0.15 s per utterance averaged, which is below the noise of every
 * benchmark here.
 */
