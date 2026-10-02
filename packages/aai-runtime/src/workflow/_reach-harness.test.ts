// Copyright 2026 the AAI authors. MIT license.
// The reach counters: what `measure` reads off one operation log, and how
// `noteScenario` folds a scenario into a corpus total.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { runConcurrentScenario } from "./_concurrent-harness.ts";
import { measure, noteScenario, zeroStats } from "./_reach-harness.ts";
import { label, runScenario } from "./_resume-harness.ts";
import type { Ev } from "./_schedule-harness.ts";

describe("measure", () => {
  test("counts overlaps, delivery switches and the answers the laws care about", () => {
    const events: Ev[] = [
      { i: 0, kind: "call", method: "getRun", by: "p.d0.0" },
      { i: 1, kind: "call", method: "getRun", by: "p.d0.1" },
      { i: 0, kind: "ret", method: "getRun", by: "p.d0.0" },
      { i: 1, kind: "ret", method: "getRun", by: "p.d0.1" },
      { i: 2, kind: "call", method: "closeHook", by: "p.d0.0", args: ["wrun_1", "hook!t#0"] },
      { i: 2, kind: "ret", method: "closeHook", by: "p.d0.0", value: false },
      { i: 3, kind: "call", method: "createRun", by: "driver", args: [{}] },
      { i: 3, kind: "throw", method: "createRun", by: "driver" },
      {
        i: 4,
        kind: "call",
        method: "setStatus",
        by: "p.cancel0",
        args: ["wrun_1", "cancelled", undefined, ["pending", "running"]],
      },
      { i: 4, kind: "ret", method: "setStatus", by: "p.cancel0", value: true },
    ];
    const stats = measure(events, [[1], [1]]);
    expect(stats).toMatchObject({
      journalOverlaps: 1,
      deliverySwitches: 2,
      closeRefused: 1,
      closeWon: 0,
      startsRefused: 1,
      cancelsMidWalk: 1,
      agreeingWalks: 1,
      crossRunOverlaps: 0,
    });
  });

  test("an empty log, one walk, measures zero", () => {
    expect(measure([], [[1]])).toEqual(zeroStats());
  });
});

describe("noteScenario", () => {
  test("adds the run's counters, and duplicate step bodies against the oracle", async () => {
    const program = label([{ t: "step", name: "", value: 1 }]);
    const oracle = await runScenario(program);
    const [scheduler] = fc.sample(fc.scheduler(), { numRuns: 1, seed: 3 });
    if (!scheduler) throw new Error("fast-check produced no scheduler");
    const run = await runConcurrentScenario(program, {
      scheduler,
      deliveries: 2,
      stepConcurrency: 1,
      arm: "direct",
    });

    const total = zeroStats();
    noteScenario(total, { ...run, counts: { s0: 3 } }, oracle);
    expect(total.duplicateSteps).toBe(2);
    expect(total.journalOverlaps).toBe(run.stats.journalOverlaps);
    // A cancel counts only when it really cut work short of the oracle.
    expect(total.cancelsMidWalk).toBe(0);
  });
});
