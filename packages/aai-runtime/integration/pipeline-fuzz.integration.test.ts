// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleaving fuzz over the pipeline transport.
 *
 * The scripted specs in `host/transports/` each assert ONE interleaving. This
 * suite drives the transport through random sequences of the events a real
 * session produces — STT partials/finals, TTS audio, client cancels, resets,
 * barge-ins landing inside a tool execution — and checks GLOBAL invariants
 * instead of specific outcomes, so it covers orderings nobody wrote a spec for.
 *
 * It needs no API keys (the fakes in `host/_pipeline-test-fakes.ts` stand in for
 * every provider); it lives in the integration tier only because it is too slow
 * for the 5s unit budget.
 *
 * Three things to know before changing it:
 *
 * - **Every oracle must be a property a real provider or client enforces.** The
 *   strongest one here validates each LLM request payload the way Anthropic and
 *   OpenAI do (`promptProblems`): a `tool` result with no matching `tool-call`
 *   is a hard 400. That oracle is what surfaced the history-cap bug fixed in
 *   `pipeline-history.ts` (`capLlm`), which is why `LONG_SEEDS` exists — those
 *   are the only seeds that push past `DEFAULT_MAX_HISTORY` and make the cap
 *   trim at all.
 * - **The REGRESSION guard for that bug is the deterministic spec in
 *   `transports/pipeline-history.test.ts`**, not this suite. Whether a trim
 *   splits a tool pair depends on the window's alignment with turn boundaries,
 *   so a random walk reaches it only sometimes. Discovery and regression are
 *   different jobs; do not delete that spec on the grounds that this one covers
 *   the same ground. That is measured rather than assumed: reverting the
 *   `capLlm` fix leaves THIS suite green — both before and after it moved to
 *   fast-check — while `pipeline-history.test.ts` fails immediately.
 * - **The generator must not itself break a provider contract.** An earlier
 *   draft emitted TTS audio at arbitrary moments and the truncation oracle duly
 *   fired — on the generator, not the transport. A fake that does something no
 *   real provider does produces findings that cost real time to dismiss.
 *
 * Finally: an all-green fuzz proves nothing if it never reached the interesting
 * state. The coverage floors at the bottom fail the suite when the random walk
 * stops visiting barge-in, tool execution, history trimming, or reply
 * completion — a greener result than last run is usually a broken generator
 * rather than a fixed bug. fast-check has no equivalent (`fc.statistics` only
 * prints), so those stay hand-rolled and accumulate across runs.
 *
 * ## What fast-check generates
 *
 * Everything a seeded PRNG used to decide, as one structured value per run, so a
 * failure shrinks instead of reporting a seed: the step script (action + the
 * utterance opener + the pause after it), the LLM script pattern (which turns
 * call a tool), each tool call's behaviour, and `preemptiveGeneration`. The
 * middle two are SHORT lists consumed cyclically rather than one entry per
 * possible call — a run may consume thousands of script steps, and generating
 * that many would print a wall of a counterexample and shrink to nothing
 * readable.
 *
 * ## The `preemptiveGeneration` arm
 *
 * The flag is generated rather than pinned off, so both arms run in one
 * property and a counterexample names which one it came from. Two things move
 * with it, and both are honest limits rather than tidiness:
 *
 * - The exact-text reply-integrity oracle is SKIPPED in the ON arm, because a
 *   speculation's generated text cannot be attributed to a reply at the moment
 *   it is served. See `checkReplyIntegrity` for the full reasoning; the adopted
 *   reply's text is pinned deterministically in
 *   `transports/pipeline-preemption.test.ts` instead.
 * - The turn-serialization bound widens by the speculation budget, because a
 *   speculation is deliberately outside the turn chain.
 *
 * What the arm ADDS is guardrail 1 as a global property — nothing may reach TTS
 * between a cleanly completed reply and the next `onReplyStarted`, which is
 * exactly the idle window a speculation runs in.
 *
 * ## Two mechanical notes
 *
 * The step count carries an unusual `minLength`: a run spends its first steps
 * getting the session past `start()`, so a shorter script finishes before a
 * reply ever completes and the interesting oracles never fire.
 *
 * And Biome's `noSecrets` rule is off for the `_*-fuzz-*.ts` files alongside
 * test files (`biome.json`), because a camelCase action name like
 * `armBargeInFromTool` reads as high-entropy to it — and mangling a domain
 * identifier to satisfy a false positive is the wrong trade.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { scriptPatternArb, shortRunArb } from "./_pipeline-fuzz-input.ts";
import { installHarness, LONG_RUNS, LONG_STEPS, runOne, SHORT_RUNS } from "./_pipeline-fuzz-run.ts";

// Split into two tests rather than one: each gets its own timeout budget, and
// the integration profile allows 30s. One combined run measured ~10s locally,
// which a loaded shared runner can stretch past the limit.
describe("pipeline transport — randomized interleaving", () => {
  test("global invariants hold across random event orderings", async () => {
    const harness = installHarness();
    try {
      await fc.assert(
        fc.asyncProperty(shortRunArb, async (input) => {
          const violations = await runOne(input, input.steps.length, harness.cov);
          // Sliced: a systemic break should report a readable sample, not
          // hundreds of lines of the same thing.
          expect(violations.slice(0, 8)).toEqual([]);
        }),
        { numRuns: SHORT_RUNS },
      );
      expect(harness.unhandled).toEqual([]);
    } finally {
      harness.dispose();
    }

    // Coverage floors — see the module doc. Set roughly 3x below the lowest of
    // four measured runs (actuals noted alongside) because these vary more than
    // they used to: the old harness ran a FIXED seed list, so its counts were
    // near-constant, while fast-check draws a fresh seed per CI run and the step
    // count is itself generated. That is the trade — new interleavings every run
    // in exchange for looser floors — and it is the right one, because a floor
    // is here to catch a generator that stopped reaching a state, never to pin a
    // count.
    const { cov } = harness;
    // `PIPELINE_FUZZ_COVERAGE=1` prints the whole table, the way
    // `S2S_FUZZ_COVERAGE=1` does for the S2S property. It is how the actuals
    // quoted below were taken, and how the next person re-takes them.
    if (process.env.PIPELINE_FUZZ_COVERAGE === "1") console.log(JSON.stringify(cov, null, 2));
    // One reader for the counters: a `?? 0` at every call site is most of this
    // function's cognitive-complexity budget.
    const count = (key: string): number => cov[key] ?? 0;
    expect(count("replyStarted"), "no reply ever started").toBeGreaterThan(120); // ~350
    expect(count("replyDone"), "no reply ever completed").toBeGreaterThan(25); // ~95
    // LOWERED from 25 when `preemptiveGeneration` joined the generated world,
    // and this is the one floor in the file that has ever moved DOWN. Roughly
    // half the runs now have the flag on, and those runs skip the exact-text
    // check entirely (see checkReplyIntegrity), so the same generator that
    // measured ~95 now measures 30-50 over five runs. The floor is 3x below that
    // minimum, on the same rule as every other one here.
    expect(count("replyIntegrityChecked"), "reply text never checked").toBeGreaterThan(10); // 30-50
    expect(count("toolExecuted"), "no tool ever ran").toBeGreaterThan(18); // ~62
    expect(count("llmRequestWithTool"), "no request carried a tool result").toBeGreaterThan(18); // ~65
    expect(count("bargeInFromInsideTool"), "never barged in during a tool").toBeGreaterThan(12); // ~35
    // Barge-in needs the turn to have SPOKEN, so this is the most
    // timing-sensitive counter of the set.
    expect(count("cancelled"), "no reply was ever cancelled").toBeGreaterThan(7); // ~33
    // Both ways a turn's LLM can fail, because they are separate reporters: an
    // `error` stream part, and a request that never streams at all. Each keeps
    // the fatality oracle in `createCallbacks` reachable — it passed on arrival
    // precisely because nothing here could fail a turn. These were the two
    // floors in this file carrying no measured actual, which is what makes a
    // floor un-re-measurable when it flakes; taken over three runs (2026-08-16)
    // with `PIPELINE_FUZZ_COVERAGE=1`, same 3x-below rule as the rest.
    expect(count("error:llm"), "no turn's LLM stream ever failed").toBeGreaterThan(12); // 38-71
    expect(count("llmRefused"), "no LLM request was ever refused").toBeGreaterThan(4); // 12-26
    // And every one of them was reported NON-fatally, so a regression to the
    // `onError` default is a failure here rather than a silent gap.
    expect(count("nonFatal:llm")).toBe(count("error:llm"));
    // False-interruption recovery. Both states were unreachable here until the
    // resume deadline was shortened (see `speechIdleTimeoutMs` in runOne), so
    // an all-green run said nothing about resumes at all. The mooted one is
    // the more interesting oracle — it is where `dropTrailingUser`, the
    // unspoken-turn abort and the turn gate meet — and it is much rarer, so it
    // gets the lower floor rather than a generator nudge.
    // False-interruption recovery, which this suite could not reach at all
    // until the `noiseBargeIn` action and the short `speechIdleTimeoutMs` in
    // `runOne`: the resume fires when the speaking edge goes idle, the shipped
    // deadline is 3500 ms, and a run here lasts ~250 ms. Measured over six
    // runs: partial barge-ins 51-71 (8 before the nudge), resumes 10-31 (0-1
    // before it).
    expect(count("falseInterruptionResumed"), "no reply was ever resumed").toBeGreaterThan(3);
    // The heard cursor's zero case — a reply that produced words and forwarded
    // no audio, so history records none of it. Keeps `checkPrompt`'s
    // no-audio-no-record oracle reachable.
    expect(count("interruptedWithNothingHeard"), "nothing was cut pre-audio").toBeGreaterThan(60); // ~192-243
    // `resumeMooted` — a committed final killing a still-silent resume turn —
    // is DELIBERATELY counted but NOT floored. It is the more interesting
    // oracle (dropTrailingUser, the unspoken-turn abort and the turn gate all
    // meet there), and it is reached: 1-8 times per run over the same six runs.
    // But its window is the resume turn's time-to-first-audio, ~1 ms with this
    // fake LLM, so a floor even at 1 would flake, and widening it means
    // distorting the generator for one counter. `pipeline-voice-events.test.ts`
    // pins the behaviour deterministically instead. What it CAN carry is an
    // invariant rather than a floor: a resume can only be mooted if one fired,
    // and each fired resume can be mooted at most once.
    expect(count("resumeMooted")).toBeLessThanOrEqual(count("falseInterruptionResumed"));

    // PREEMPTIVE GENERATION. The flag is generated, so roughly half the runs
    // carry it and these counters come off the transport's own log lines — the
    // same lines the feature's doc names as the instrument that would justify
    // flipping the default, so flooring them also pins that they are emitted.
    // Measured over five runs: started 41-68, discarded 38-65.
    expect(count("speculationStarted"), "no speculation ever started").toBeGreaterThan(13);
    expect(count("speculationDiscarded"), "no speculation was ever discarded").toBeGreaterThan(12);
    // The two rules the recorded confidence sawtooth dictated, each floored on
    // its own so a policy that stopped applying one is a failure rather than a
    // shift in the totals. Measured locally: superseded 5-10, mismatch 6-13.
    //
    // `superseded` is floored at 0, not under that range, because CI then
    // produced **1** — the long left tail this file's own harness notes warn
    // about, since what a walk reaches is correlated WITHIN a run rather than
    // independent per step. Five local runs are not a range, and the observed
    // minimum is what a floor has to sit under; a floor above it fails a PR that
    // changed nothing here (#1268 did not touch this package). What the floor is
    // FOR survives at 0: catching a rule that stopped applying at all, not
    // pinning how often it applies.
    //
    // `mismatch` keeps its floor because nothing has been observed below it.
    // It shares the same generator and the same tail risk, so if it ever does
    // flake the answer is the same one, not a multiplier.
    expect(count("speculationDiscarded:superseded"), "no partial ever revised").toBeGreaterThan(0);
    expect(count("speculationDiscarded:mismatch"), "no final ever mismatched").toBeGreaterThan(1);
    // ADOPTION is counted and DELIBERATELY NOT floored, on the `resumeMooted`
    // precedent above. It needs the transport IDLE at the instant a confident
    // interim lands, and this harness is busy by construction — a 5 ms
    // `silenceTimeoutMs` keeps nudge turns running and the generator keeps audio
    // playing out — so it lands 0-6 times per run over five runs, and a floor
    // even at 1 would flake. Widening it means distorting the generator for one
    // counter. `transports/pipeline-preemption.test.ts` pins adoption
    // deterministically instead. What this CAN carry is the accounting
    // invariant: every speculation is claimed at most once, either way.
    expect(count("speculationAdopted") + count("speculationDiscarded")).toBeLessThanOrEqual(
      count("speculationStarted"),
    );
  }, 60_000);

  test("global invariants hold across a long session past the history cap", async () => {
    const harness = installHarness();
    try {
      await fc.assert(
        fc.asyncProperty(
          scriptPatternArb,
          // Prior history length varies the starting alignment: whether a trim
          // splits a tool pair depends on where the window boundary falls
          // inside a turn.
          fc.nat({ max: 3 }),
          async (script, seedHistory) => {
            const violations = await runOne(
              // Never refused: this property's job is to accumulate history past
              // the cap, and a refused request contributes no turn to it. The
              // `fail` turns the shared pattern can carry are fine — they commit
              // the user's side and exercise the fatality oracle here too.
              // Preemption off: this property fires only finals, so nothing
              // would ever speculate, and leaving it off keeps the exact-text
              // integrity oracle live here (see checkReplyIntegrity).
              {
                steps: [],
                script,
                tools: [{ kind: "ok" }],
                refusals: [false],
                preemptiveGeneration: false,
              },
              LONG_STEPS,
              harness.cov,
              { longSession: true, seedHistory },
            );
            expect(violations.slice(0, 8)).toEqual([]);
          },
        ),
        { numRuns: LONG_RUNS },
      );
      expect(harness.unhandled).toEqual([]);
    } finally {
      harness.dispose();
    }

    // Each test installs its OWN harness, so this print is not redundant with
    // the one in the property above — without it the only floor this property
    // carries could not be re-measured at all.
    if (process.env.PIPELINE_FUZZ_COVERAGE === "1") {
      console.log(JSON.stringify(harness.cov, null, 2));
    }
    // The state this property exists for: past DEFAULT_MAX_HISTORY the cap
    // trims on every push, which is what can orphan a tool result.
    //
    // The one floor in this file that was never MEASURED — 10 was a guess, and
    // a floor with no recorded actual cannot be re-checked (which is the whole
    // argument of `check-property-floors`, where this line was the tree's only
    // baselined entry). Measured 2026-09-01 over 24 consecutive runs:
    // 229-425, minimum 229. The floor sits under that observed MINIMUM rather
    // than under a fraction of the mean, on the rule the root guide states: a
    // walk's counters are correlated within a run, so these distributions have
    // long left tails and only the unluckiest run observed is evidence.
    expect(
      harness.cov.llmRequestAtHistoryCap ?? 0,
      "never reached the history cap",
    ).toBeGreaterThan(75); // 229-425 over 24 runs
  }, 60_000);
});
