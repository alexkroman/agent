// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's DEFINING property, over bodies nobody wrote by hand.
 *
 * > For any body B and any interruption point i, resuming at i yields the same
 * > result as running B uninterrupted, and every step body executes exactly as
 * > often as it would have.
 *
 * Everything else about this engine is a mechanism in service of that sentence,
 * and `workflow-replay.test.ts` / `workflow-engine.test.ts` state the mechanisms
 * — does `appendStep` write a row, does `claimSleep` decide a deadline once, does
 * a redelivery answer from the journal. Each is a claim about one hand-chosen
 * body at one hand-chosen moment. Four of the five defects a review found in this
 * engine violate the sentence above, and all four were found by a person reading
 * the code rather than by any of those tests: a suspend thrown inside `ctx.step`
 * journaled as a permanent failure, a nested `ctx.step` deadlocking the
 * concurrency gate, `closeHook` not being a compare-and-set, and `cancel` never
 * stopping the body. A property does not need anyone to predict which body and
 * which moment.
 *
 * ## What is asserted, and which of the four claims each covers
 *
 * Every generated program is run four ways: once uninterrupted (the ORACLE),
 * once per step boundary with the worker killed there, once per SUSPENSION with
 * the whole engine torn down and rebuilt over the same journal, and — for the
 * sequential grammar — once per step boundary with `cancel` called there.
 *
 * The third is a second CRASH MODEL rather than a third interruption point, and
 * it exists because the first two cannot see the dispatcher: they build the
 * engine with `dispatch: () => undefined` and hand-drive resumption, so a run
 * that was never re-delivered after a restart passed them for as long as the
 * defect lived. `_workflow-rebuild-harness.ts` carries the table of what each
 * model destroys.
 *
 * 1. **The uninterrupted run reaches the answer the grammar predicts.** An
 *    ABSOLUTE claim, not a comparison, and it is the one that catches a defect
 *    which breaks the crashed and the uncrashed run identically — as the
 *    suspend-in-step swallow did, before the engine refused that body outright.
 *    `expectedOutput` computes the answer without the engine.
 * 2. **Status, output, error, journal keys and per-step invocation counts are
 *    identical with and without the crash.** Counting real invocations rather
 *    than journal rows is deliberate: the two agreeing is part of what is under
 *    test.
 * 3. **No run ends non-terminal** — a stuck run answers `running` and fails (1).
 * 4. **After `cancel` resolves, no further step body starts**, and the run is
 *    recorded `cancelled`.
 *
 * ## Why this is a UNIT test
 *
 * Nothing here touches a clock, a socket or a disk. A `ctx.sleep` SUSPENDS
 * rather than waiting, so a 60-second wait costs a journal row, and the driver
 * advances it with `wakeSleeps`. The only real timer in the path is the zero
 * delay a retryable step waits out, and the grammar's retryable failure is a
 * plain `Error`, for which `retryDelay` is 0.
 *
 * The GRAMMAR is the arbitraries below; `_workflow-resume-harness.ts` is what
 * turns one of their values into a workflow body, runs it, and kills the worker
 * — plus the three shapes this deliberately does not generate, and why.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type RebuildScenario, runRebuildScenario } from "./_workflow-rebuild-harness.ts";
import {
  expectedOutput,
  fails,
  type HookMode,
  type Leaf,
  label,
  type Node,
  type Program,
  runScenario,
  type Scenario,
} from "./_workflow-resume-harness.ts";

const leafArb: fc.Arbitrary<Leaf> = fc
  .tuple(fc.constantFrom("step" as const, "flaky" as const), fc.integer({ min: 0, max: 9 }))
  .map(([t, value]): Leaf => ({ t, name: "", value }));

/** Every way a generated `waitFor` can be answered. */
const ALL_HOOK_MODES: readonly HookMode[] = ["signal", "timedSignal", "timeout"];

/**
 * One statement of a body.
 *
 * `concurrent` adds the fan-out shapes and `failing` adds the step that fails
 * the run — both off for the cancel property, whose claim ("nothing starts after
 * the cancel resolves") is only crisp when the body issues one step at a time.
 *
 * `hookModes` narrows which waits may be generated, which only the rebuild
 * property uses and whose reason is stated where it does.
 */
function nodeArb(
  concurrent: boolean,
  failing: boolean,
  hookModes: readonly HookMode[] = ALL_HOOK_MODES,
): fc.Arbitrary<Node> {
  const shapes: fc.Arbitrary<Node>[] = [
    leafArb,
    fc.integer({ min: 2, max: 3 }).map((count): Node => ({ t: "loop", name: "", count })),
    fc.constant<Node>({ t: "sleep", waitLabel: "" }),
    fc.constantFrom(...hookModes).map((mode): Node => ({ t: "hook", token: "", mode })),
    fc
      .array(leafArb, { minLength: 1, maxLength: 2 })
      .map((children): Node => ({ t: "nested", name: "", children })),
  ];
  if (concurrent) {
    shapes.push(
      fc
        .array(leafArb, { minLength: 2, maxLength: 3 })
        .map((children): Node => ({ t: "all", children })),
      fc
        .tuple(fc.integer({ min: 1, max: 3 }), fc.array(leafArb, { minLength: 2, maxLength: 3 }))
        .map(([width, children]): Node => ({ t: "map", width, children })),
    );
  }
  if (failing) shapes.push(fc.constant<Node>({ t: "boom", name: "" }));
  return fc.oneof(...shapes);
}

/** A whole body, unlabelled — the property labels it. */
function programArb(
  concurrent: boolean,
  failing: boolean,
  maxLength: number,
): fc.Arbitrary<Program> {
  return fc.array(nodeArb(concurrent, failing), { minLength: 1, maxLength });
}

/**
 * States the generated corpus has to have REACHED, or the properties above are
 * satisfied by bodies that never did anything interesting.
 *
 * Floors are set under the OBSERVED MINIMUM over 20 runs, with the range beside
 * each — never a fraction of the mean. What a generated walk reaches is
 * correlated within a run rather than independent per step, so these
 * distributions have long left tails.
 */
const reached = {
  /** Crashes that really made a delivery reject. */
  crashes: 0,
  /** Crash scenarios that resumed with at least one step already journaled. */
  resumesOffJournal: 0,
  /** Suspends the driver had to advance past, across every scenario. */
  suspends: 0,
  /** Hook waits answered by a signal. */
  signals: 0,
  /** Programs that fanned steps out concurrently. */
  fanOut: 0,
  /** Programs with a step nested inside another step. */
  nested: 0,
  /**
   * Nested programs run through a gate with ONE slot.
   *
   * The state that distinguishes a re-entrant step gate from a plain counting
   * semaphore: with two slots free the inner step simply takes one, so a nested
   * program at a wider gate proves nothing about the deadlock. Small by
   * construction — one width in four times one shape in eight — so the floor is
   * `> 0`, which is what a "never reached" floor is for.
   */
  gateReentry: 0,
  /** Programs whose run FAILED, so the failure path is compared too. */
  failures: 0,
  /** Cancels that landed while the body still had steps ahead of it. */
  earlyCancels: 0,
  /** Engine REBUILDS, each of which is one boot sweep that had to re-deliver. */
  rebuilds: 0,
  /** Rebuilds whose fresh engine inherited at least one journaled step. */
  rebuildsOffJournal: 0,
  /** Step bodies that ran only AFTER the run had been handed to a fresh engine. */
  stepsAfterRebuild: 0,
  /** Scenarios that had to be handed on more than once. */
  multiRebuilds: 0,
  /**
   * Rebuilt scenarios that had a step nested inside a step AND inherited
   * journaled work.
   *
   * The sharp edge, and it is not hypothetical: on replay a settled OUTER step
   * answers from the journal without entering its callback, so its children's
   * keys are written, never re-read, and sit unread for the rest of the walk. A
   * divergence check that read "journaled work this walk cannot explain" as a
   * fault therefore failed an ordinary resumable run with no author mistake in
   * it — caught by the sibling property, which shrank both of its
   * counterexamples to a `nested` step. This is the state that keeps the same
   * claim honest across a REBUILD, where the inherited journal is the whole
   * input.
   *
   * The weaker "a nested program was rebuilt at all" was counted too and dropped
   * as decoration: it measured IDENTICAL to this on all 20 calibration runs, and
   * a second floor whose information the first already carries is the compliance
   * floor `check:property-floors` exists to discourage.
   */
  nestedOffJournal: 0,
};

/**
 * The status the grammar predicts. An ABSOLUTE claim: the comparison against the
 * oracle cannot see a defect that breaks both schedules the same way, and the
 * suspend-in-step swallow was exactly one of those.
 */
function soundStatus(program: Program): "completed" | "failed" {
  return fails(program) ? "failed" : "completed";
}

/**
 * The output the grammar predicts, computed without the engine.
 *
 * `undefined` for a failing program, because a failed run's record carries no
 * output — `recordOutcome` patches only the error.
 */
function soundOutput(program: Program): unknown {
  return fails(program) ? undefined : expectedOutput(program);
}

/**
 * Everything two schedules of one program must agree on, as ONE value.
 *
 * Compared whole rather than field by field so a divergence prints both runs
 * side by side; a chain of five `expect`s prints only the first field to differ,
 * which is rarely the informative one.
 */
function comparable(run: Scenario): Record<string, unknown> {
  return {
    status: run.status,
    output: run.output,
    error: run.error,
    // Real invocations, not journal rows — the two agreeing is part of what is
    // under test.
    counts: run.counts,
    keys: run.keys,
  };
}

/** What one uninterrupted run exercised. */
function noteOracle(program: Program, stepConcurrency: number, run: Scenario): void {
  if (program.some((node) => node.t === "all" || node.t === "map")) reached.fanOut++;
  if (program.some((node) => node.t === "nested")) reached.nested++;
  if (stepConcurrency === 1 && program.some((node) => node.t === "nested")) reached.gateReentry++;
  if (fails(program)) reached.failures++;
  reached.suspends += run.suspends;
  reached.signals += run.signalled;
}

/** What one crashed-and-resumed scenario exercised. */
function noteResumed(run: Scenario, crashAt: number): void {
  reached.suspends += run.suspends;
  reached.signals += run.signalled;
  if (!run.crashed) return;
  reached.crashes++;
  if (crashAt > 1) reached.resumesOffJournal++;
}

describe("a run resumed after its worker died", () => {
  test("answers what the uninterrupted run answered, having run each step body as often", async () => {
    await fc.assert(
      fc.asyncProperty(
        programArb(true, true, 5),
        fc.integer({ min: 1, max: 4 }),
        async (raw, stepConcurrency) => {
          const program = label(raw);
          const oracle = await runScenario(program, { stepConcurrency });
          // Terminal, always: a stuck run answers `running` here and says so.
          expect(oracle.status, "the uninterrupted run did not answer soundly").toBe(
            soundStatus(program),
          );
          expect(oracle.output, "the uninterrupted output disagrees with the grammar").toEqual(
            soundOutput(program),
          );
          noteOracle(program, stepConcurrency, oracle);

          for (let crashAt = 1; crashAt <= oracle.total; crashAt++) {
            const resumed = await runScenario(program, { stepConcurrency, crashAt });
            expect(comparable(resumed), "the resumed run diverged").toEqual(comparable(oracle));
            noteResumed(resumed, crashAt);
          }
        },
      ),
      { numRuns: 60 },
    );

    // Ranges over 22 runs, re-measured. Without these the equality assertions
    // above are satisfied by a corpus of one-step bodies that never crashed at
    // all — so what each floor is for is catching a state NEVER REACHED, not
    // pinning how often one is.
    //
    // `suspends` is the one to read before touching any of these. Its floor was
    // 90 against a recorded 155-276, i.e. 58% of the recorded minimum — the same
    // fraction its siblings sit at, and calibrated against a left tail that does
    // not hold. A real `pnpm check` run drew **62**, below all 22 samples here,
    // and failed the gate on a tree whose change (queue columns, in aai-server)
    // cannot affect this suite. Re-measuring on pristine main gave 104-200, so
    // the recorded range was optimistic too: this walk's counts are correlated
    // WITHIN a run rather than independent per step, which is exactly the long
    // left tail this repo's guide warns about ("one run is not a range").
    //
    // So it is floored under the OBSERVED OUTLIER rather than under a fraction
    // of a mean, which is what the guide asks for and what the other seven
    // already happen to satisfy. 30 is under 62 with room for a worse draw and
    // still an order of magnitude above "nothing ever suspended", which is the
    // only thing it has to catch.
    expect(reached.crashes, "no crash ever failed a delivery").toBeGreaterThan(80); // 135-229
    expect(reached.resumesOffJournal, "no resume read a step off the journal").toBeGreaterThan(55); // 95-185
    expect(reached.suspends, "nothing ever suspended").toBeGreaterThan(30); // 104-200, and 62 seen live
    expect(reached.fanOut, "no program fanned out").toBeGreaterThan(10); // 21-37
    expect(reached.nested, "no program nested a step inside a step").toBeGreaterThan(5); // 13-23
    expect(reached.gateReentry, "no nested step ran through a one-slot gate").toBeGreaterThan(0); // 1-10
    expect(reached.signals, "no hook was ever answered by a signal").toBeGreaterThan(12); // 27-123
    expect(reached.failures, "no generated run ever failed").toBeGreaterThan(3); // 11-26
  });
});

describe("a run cancelled mid-body", () => {
  // Sequential bodies only. The claim is "nothing starts after the cancel
  // resolves", and a fan-out makes it untrue for an uninteresting reason: a
  // sibling already past `throwIfAborted` and awaiting `claimAttempt` will run,
  // and nothing outside the engine can see which siblings those were.
  test("stops the body where it stands, and records the run cancelled", async () => {
    await fc.assert(
      fc.asyncProperty(
        programArb(false, false, 4),
        fc.integer({ min: 1, max: 3 }),
        async (raw, stepConcurrency) => {
          const program = label(raw);
          const oracle = await runScenario(program, { stepConcurrency });
          expect(oracle.status, "the uninterrupted run did not answer soundly").toBe(
            soundStatus(program),
          );

          for (let cancelAt = 1; cancelAt <= oracle.total; cancelAt++) {
            const stopped = await runScenario(program, { stepConcurrency, cancelAt });
            expect(stopped.status, "a cancelled run was not recorded cancelled").toBe("cancelled");
            // The cancelling invocation is the LAST one: `replayRun` checks the
            // signal before each step executes, so nothing may start after.
            expect(stopped.total, "a step body ran after the cancel resolved").toBe(cancelAt);
            if (cancelAt < oracle.total) reached.earlyCancels++;
          }
        },
      ),
      { numRuns: 40 },
    );

    // Range over 20 runs. A cancel on the FINAL step proves almost nothing —
    // there was nothing left to stop — so the floor is on the ones that landed
    // with work still ahead.
    expect(reached.earlyCancels, "every cancel landed on the last step").toBeGreaterThan(22); // 46-97
  });
});

/**
 * A body that is GUARANTEED to suspend, with a `ctx.sleep` spliced in at a
 * generated position.
 *
 * Forced by INSERTION rather than by filtering, so every generated value maps to
 * a legal one and shrinking stays well behaved — a rejected draw would shrink
 * toward a program with nothing to hand over, which is the one case this
 * property cannot see anything in.
 *
 * Two shapes the grammar leaves out, both because nothing in this model would
 * ever move the run again and the finding would be the harness's:
 *
 * - **A hook that PARKS** (`signal`, and `timedSignal`, whose answer the other
 *   driver supplies). `resumableRuns` deliberately EXCLUDES a run holding an
 *   open window and no outstanding sleep — a park is not a stall — so a rebuild
 *   correctly declines to re-deliver it. Only the already-shut `timeout` window
 *   is generated, which suspends nothing.
 * - **A step that fails the run.** A `boom` reached before the spliced sleep
 *   ends the run terminally, and the scenario then exercises no rebuild at all.
 *   The killed-worker property above is where the failure path is compared.
 */
function suspendingProgramArb(): fc.Arbitrary<Program> {
  return fc
    .tuple(fc.array(nodeArb(true, false, ["timeout"]), { maxLength: 4 }), fc.integer({ min: 0 }))
    .map(([nodes, at]): Program => {
      const out = [...nodes];
      out.splice(Math.min(at, out.length), 0, { t: "sleep", waitLabel: "" });
      return out;
    });
}

/** What one rebuilt scenario exercised. */
function noteRebuilt(program: Program, run: RebuildScenario): void {
  reached.rebuilds += run.rebuilds;
  reached.rebuildsOffJournal += run.resumedOffJournal;
  reached.stepsAfterRebuild += run.stepsAfterRebuild;
  if (run.rebuilds > 1) reached.multiRebuilds++;
  if (run.resumedOffJournal > 0 && program.some((node) => node.t === "nested")) {
    reached.nestedOffJournal++;
  }
}

describe("a run handed to a FRESH engine over the same journal", () => {
  // The other crash model keeps the process and takes the delivery away. This
  // one keeps the JOURNAL and takes the process's timers away, which is what a
  // restart and an `aai dev` rebuild both are — and it is the only one of the
  // two that constructs `createInProcessWorkflowEngine`, so it is the only one
  // in which the boot sweep is under test. No dispatcher is injected, because
  // injecting one switches the sweep off.
  test("answers what the uninterrupted run answered, having run each step body as often", async () => {
    await fc.assert(
      fc.asyncProperty(suspendingProgramArb(), async (raw) => {
        const program = label(raw);
        const oracle = await runScenario(program);
        expect(oracle.status, "the uninterrupted run did not answer soundly").toBe(
          soundStatus(program),
        );
        expect(oracle.output, "the uninterrupted output disagrees with the grammar").toEqual(
          soundOutput(program),
        );

        const rebuilt = await runRebuildScenario(program);
        // Terminal is part of this: `soundStatus` is `completed` for every
        // program this grammar generates, so a run the sweep never re-delivered
        // answers `running` here and fails.
        expect(comparable(rebuilt), "the rebuilt run diverged").toEqual(comparable(oracle));
        noteRebuilt(program, rebuilt);
      }),
      { numRuns: 40 },
    );

    // Ranges over 20 runs, each floor set under the OBSERVED MINIMUM. Without
    // these the equality assertion is satisfied by a corpus that never handed a
    // run over at all — which is precisely the vacuity that let the sibling
    // property sit green through the stranded-run bug for as long as it lived.
    //
    // **Re-measured over 20 fresh runs when `nestedWait` left the grammar**, and
    // the two floors below moved because of it. That node was a step whose body
    // suspended — now a program the engine refuses, see
    // `workflow-replay-wait.ts` — so a drawn body holds fewer SUSPENDING nodes
    // than it did, and the counters that need a run to be handed over more than
    // once fell with it. The old ranges are kept beside the new ones: a floor
    // that moves down wants the evidence that it was the DISTRIBUTION and not
    // the assertion that changed.
    expect(reached.rebuilds, "no run was ever handed to a fresh engine").toBeGreaterThan(30); // 45-55 (was 50-61)
    expect(reached.rebuildsOffJournal, "no rebuild inherited a journaled step").toBeGreaterThan(15); // 26-45 (was 29-44)
    // `stepsAfterRebuild` is MEASURED and deliberately UNFLOORED, joining
    // `resumeMooted` and `speculationAdopted` — and it is the one counter here
    // whose recorded range was simply wrong. Floored at `> 2` against a
    // recorded 6-35, it produced **0** in 1 run of 12: not a small minimum but
    // a genuinely empty one, because it is `started - startedAtFirstRebuild`
    // and a program whose rebuilds all land at its END starts no body after
    // the first. So `> 0` fails too, and there is no number this can take.
    //
    // Nothing is lost by unflooring it, which is why this is not a hole:
    // `rebuildsOffJournal > 15` above is the SUBSTANTIVE guarantee — a rebuild
    // that inherited a journaled step is the case this property exists for —
    // and `stepsAfterRebuild` only measured the VOLUME of work after one. The
    // alternative is forcing the shape in the generator by appending, which
    // would re-shift all five distributions to buy back a volume count.
    expect(reached.stepsAfterRebuild, "measured, not floored").toBeGreaterThanOrEqual(0); // 0-35
    // The tightest of the five, and the one that actually tripped on the new
    // grammar before this recalibration: a `> 3` floor against a measured
    // minimum of 4 failed 1 run in 5.
    expect(reached.multiRebuilds, "no run was handed on more than once").toBeGreaterThan(1); // 4-14 (was 8-19)
    expect(
      reached.nestedOffJournal,
      "no fresh engine inherited a nested step's journaled children",
    ).toBeGreaterThan(1); // 5-17 (was 3-12)
  });
});
