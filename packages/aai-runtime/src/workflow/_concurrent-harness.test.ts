// Copyright 2026 the AAI authors. MIT license.
// `runConcurrentScenario` on one small program: what it reports, so the laws
// read a run that really happened rather than an empty one.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { runConcurrentScenario } from "./_concurrent-harness.ts";
import { COLLIDING_STARTS } from "./_laws-harness.ts";
import { expectedOutput, label, type Program } from "./_resume-program.ts";

const PROGRAM: Program = label([
  { t: "step", name: "", value: 1 },
  { t: "step", name: "", value: 2 },
]);

describe("runConcurrentScenario", () => {
  test.each(["direct", "roundTrip"] as const)(
    "drives two deliveries to one answer (%s)",
    async (arm) => {
      await fc.assert(
        fc.asyncProperty(fc.scheduler(), async (scheduler) => {
          const run = await runConcurrentScenario(PROGRAM, {
            scheduler,
            deliveries: 2,
            stepConcurrency: 2,
            arm,
          });
          expect(run.status).toBe("completed");
          expect(run.output).toEqual(expectedOutput(PROGRAM));
          expect(run.keys).toEqual(["s0#0", "s1#0"]);
          for (const output of run.walkOutputs) expect(output).toEqual(expectedOutput(PROGRAM));
          // COLLIDING_STARTS race for the id in every scenario: one wins, the rest are refused.
          expect(run.startsWon).toHaveLength(1);
          const refused = run.log.filter((ev) => ev.method === "createRun" && ev.kind === "throw");
          expect(refused).toHaveLength(COLLIDING_STARTS - 1);
          expect(run.writes.length).toBeGreaterThan(0);
          expect(run.rounds).toBeGreaterThan(0);
        }),
        { numRuns: 5 },
      );
    },
  );
});
