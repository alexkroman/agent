// Copyright 2026 the AAI authors. MIT license.
// `runRebuildScenario`: a run handed to a FRESH in-process engine over the same
// journal, as `aai dev` does on every save, and the counters it reports.

import { describe, expect, test } from "vitest";
import { runRebuildScenario } from "./_rebuild-harness.ts";
import { expectedOutput, label } from "./_resume-program.ts";

describe("runRebuildScenario", () => {
  test("a run with nothing to wait on finishes under the first engine", async () => {
    const program = label([{ t: "step", name: "", value: 1 }]);
    const scenario = await runRebuildScenario(program);
    expect(scenario).toMatchObject({
      status: "completed",
      output: [1],
      rebuilds: 0,
      stepsAfterRebuild: 0,
    });
  });

  test("a sleep outlives its engine: a rebuild resumes it off the journal", async () => {
    const program = label([
      { t: "step", name: "", value: 1 },
      { t: "sleep", waitLabel: "" },
      { t: "step", name: "", value: 2 },
    ]);
    const scenario = await runRebuildScenario(program);
    expect(scenario.status).toBe("completed");
    expect(scenario.output).toEqual(expectedOutput(program));
    expect(scenario.rebuilds).toBeGreaterThan(0);
    expect(scenario.resumedOffJournal).toBeGreaterThan(0);
    // The step before the sleep is journaled and NOT run again by the new engine.
    expect(scenario.counts).toEqual({ s0: 1, s2: 1 });
  });
});
