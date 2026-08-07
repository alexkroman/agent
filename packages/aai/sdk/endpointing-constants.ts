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
 */
export const DEFAULT_MIN_TURN_SILENCE_MS = 1600;

/**
 * Maximum silence (ms) before AssemblyAI force-ends a turn regardless of
 * content (`max_turn_silence`). This is the pause-tolerance knob: it bounds
 * only utterances that never read as complete, so raising it is paid for by
 * hesitant speech alone and costs an ordinary finished sentence nothing —
 * unlike {@link DEFAULT_MIN_TURN_SILENCE_MS}, which taxes every turn.
 *
 * 3000 keeps the ~3s of pause tolerance the 3000 `min_turn_silence` was
 * reaching for, and applies it where it actually lands. The service default is
 * 1536, which is what silently governed every turn while the minimum sat above
 * it — so this, not the minimum's nominal 3000, is the number the hesitation
 * failures were actually measured against, and moving 1536 -> 3000 is the whole
 * of the split fix.
 *
 * **Read this before trimming it further.** The measured configuration is
 * 1600/**3500** — reward 0.68, twice, on two independent tau2-bench retail
 * runs. 3000 is a 500 ms trim off that, chosen deliberately and NOT measured on
 * its own, so treat it the way the previous trim to 2500 should have been
 * treated. That one was reverted for exactly this reason: it was reasoned from
 * the 800/1600 run, where the minimum and the maximum moved together, so the
 * run can only show that 1600/800 loses to 3500/1600 — it can never show that
 * some particular ceiling is safe alone. The failure signature to watch for is
 * specific: splits reappearing on hesitant, non-spelling utterances while
 * spelled identifiers stay intact. That asymmetry is what distinguishes the
 * ceiling from the floor; if it shows up, put this back to 3500 rather than
 * touching {@link DEFAULT_MIN_TURN_SILENCE_MS}.
 *
 * The two orderings this has to keep both hold at 3000. It stays BELOW
 * `DEFAULT_SPEECH_IDLE_TIMEOUT_MS` (3500, internal) less final-emission
 * latency, so an utterance force-ended by this ceiling still delivers its
 * final before the speaking edge goes idle — and the idle edge is what fires a
 * false-interruption resume (`host/transports/pipeline-recovery.ts`), so
 * crossing that line does not merely delay a turn, it lets the agent resume a
 * reply the caller really did interrupt. The same fact was recorded the other
 * way round when the resume had a window of its own: at a ceiling of 1600 the
 * force-end landed first and the resume proceeded instead, a behaviour change
 * rather than a tuning change. 500 ms of margin is thin — if this ceiling ever
 * goes back to its measured 3500, the idle deadline must move with it. And it
 * stays clear of the service's own 1536 default, so the ceiling is ours rather
 * than silently the service's, which is the state this constant was introduced
 * to escape.
 *
 * What the ceiling costs is pause tolerance for hesitant speech, paid ONLY by
 * utterances that never read as complete — which is the whole reason this is
 * the knob to trim rather than the minimum, and equally the reason trimming it
 * buys so little. The measured tail is content-driven and long (p90 endpoint
 * latency ~4.0-4.6s at every setting swept), so the ceiling is not what makes
 * a slow turn slow.
 */
export const DEFAULT_MAX_TURN_SILENCE_MS = 3000;
