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
 * Every generated program is run three ways: once uninterrupted (the ORACLE),
 * once per step boundary with the worker killed there, and — for the sequential
 * grammar — once per step boundary with `cancel` called there.
 *
 * 1. **The uninterrupted run reaches the answer the grammar predicts.** An
 *    ABSOLUTE claim, not a comparison, and it is the one that catches a defect
 *    which breaks the crashed and the uncrashed run identically — which the
 *    suspend-in-step swallow does. `expectedOutput` computes the answer without
 *    the engine.
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
import {
  expectedOutput,
  fails,
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

/**
 * One statement of a body.
 *
 * `concurrent` adds the fan-out shapes and `failing` adds the step that fails
 * the run — both off for the cancel property, whose claim ("nothing starts after
 * the cancel resolves") is only crisp when the body issues one step at a time.
 */
function nodeArb(concurrent: boolean, failing: boolean): fc.Arbitrary<Node> {
  const shapes: fc.Arbitrary<Node>[] = [
    leafArb,
    fc.integer({ min: 2, max: 3 }).map((count): Node => ({ t: "loop", name: "", count })),
    fc.constant<Node>({ t: "sleep" }),
    fc
      .constantFrom("signal" as const, "timedSignal" as const, "timeout" as const)
      .map((mode): Node => ({ t: "hook", token: "", mode })),
    fc
      .array(leafArb, { minLength: 1, maxLength: 2 })
      .map((children): Node => ({ t: "nested", name: "", children })),
    fc.constant<Node>({ t: "nestedWait", name: "" }),
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
};

/**
 * The status the grammar predicts. An ABSOLUTE claim: the comparison against the
 * oracle cannot see a defect that breaks both schedules the same way, and the
 * suspend-in-step swallow is exactly one of those.
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

    // Ranges over 20 runs. Without these the equality assertions above are
    // satisfied by a corpus of one-step bodies that never crashed at all.
    expect(reached.crashes, "no crash ever failed a delivery").toBeGreaterThan(80); // 140-252
    expect(reached.resumesOffJournal, "no resume read a step off the journal").toBeGreaterThan(55); // 104-210
    expect(reached.suspends, "nothing ever suspended").toBeGreaterThan(90); // 155-276
    expect(reached.fanOut, "no program fanned out").toBeGreaterThan(10); // 20-36
    expect(reached.nested, "no program nested a step inside a step").toBeGreaterThan(5); // 11-21
    expect(reached.gateReentry, "no nested step ran through a one-slot gate").toBeGreaterThan(0);
    expect(reached.signals, "no hook was ever answered by a signal").toBeGreaterThan(12); // 28-112
    expect(reached.failures, "no generated run ever failed").toBeGreaterThan(3); // 8-23
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
