// Copyright 2026 the AAI authors. MIT license.
// `runScenario`: one generated program driven through a real engine to its
// end, and the delivery facts it reports alongside the journal outcome.

import { describe, expect, test } from "vitest";
import { expectedOutput, label, type Program, runScenario } from "./_resume-harness.ts";

const STEPS: Program = label([
  { t: "step", name: "", value: 1 },
  { t: "step", name: "", value: 2 },
]);

describe("runScenario", () => {
  test("a program with nothing to wait on completes in one delivery", async () => {
    const scenario = await runScenario(STEPS);
    expect(scenario).toMatchObject({
      status: "completed",
      output: [1, 2],
      deliveries: 1,
      suspends: 0,
      crashed: false,
      keys: ["s0#0", "s1#0"],
      total: 2,
    });
  });

  test("a sleep suspends the run and a later delivery finishes it", async () => {
    const scenario = await runScenario(label([{ t: "sleep", waitLabel: "" }]));
    expect(scenario.status).toBe("completed");
    expect(scenario.suspends).toBeGreaterThan(0);
    expect(scenario.deliveries).toBeGreaterThan(1);
  });

  test("a parked hook is answered by the driver", async () => {
    const program = label([{ t: "hook", token: "", mode: "signal" }]);
    const scenario = await runScenario(program);
    expect(scenario.signalled).toBe(1);
    expect(scenario.output).toEqual(expectedOutput(program));
  });

  test("a crash mid-step is survived: the run finishes with the same output", async () => {
    const scenario = await runScenario(STEPS, { crashAt: 1 });
    expect(scenario.crashed).toBe(true);
    expect(scenario.status).toBe("completed");
    expect(scenario.output).toEqual([1, 2]);
  });

  test("a cancel issued from inside a step ends the run cancelled", async () => {
    const scenario = await runScenario(STEPS, { cancelAt: 1 });
    expect(scenario.status).toBe("cancelled");
  });

  test("a boom fails the run with its message", async () => {
    const scenario = await runScenario(label([{ t: "boom", name: "" }]));
    expect(scenario.status).toBe("failed");
    expect(scenario.error).toContain("boom s0");
  });
});
