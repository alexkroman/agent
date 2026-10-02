// Copyright 2026 the AAI authors. MIT license.
// The five laws hold on a healthy run and each FIRES on a run doctored to
// break it — a law nothing has seen fire is indistinguishable from one that
// cannot.

import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vitest";
import { type ConcurrentScenario, runConcurrentScenario } from "./_concurrent-harness.ts";
import { checkLaws } from "./_laws-harness.ts";
import { label, type Program, runScenario, type Scenario } from "./_resume-harness.ts";

const PROGRAM: Program = label([
  { t: "step", name: "", value: 1 },
  { t: "step", name: "", value: 2 },
]);

let run: ConcurrentScenario;
let oracle: Scenario;

beforeAll(async () => {
  oracle = await runScenario(PROGRAM);
  const [scheduler] = fc.sample(fc.scheduler(), { numRuns: 1, seed: 7 });
  if (!scheduler) throw new Error("fast-check produced no scheduler");
  run = await runConcurrentScenario(PROGRAM, {
    scheduler,
    deliveries: 2,
    stepConcurrency: 1,
    arm: "direct",
  });
});

describe("checkLaws", () => {
  test("is silent on a healthy run", () => {
    expect(checkLaws(PROGRAM, run, oracle)).toEqual([]);
  });

  test.each<[string, (r: ConcurrentScenario) => ConcurrentScenario, string]>([
    ["effect conservation", (r) => ({ ...r, keys: ["s0#0"] }), "journal keys diverged"],
    [
      "a step the oracle never reached",
      (r) => ({ ...r, counts: { ...r.counts, ghost: 1 } }),
      "oracle never reached it",
    ],
    ["answer agreement", (r) => ({ ...r, walkOutputs: [[9, 9]] }), "walk 0 answered [9,9]"],
    ["termination", (r) => ({ ...r, status: "running" }), "never terminated"],
    ["the recorded output", (r) => ({ ...r, output: [0] }), "the run recorded [0]"],
    ["start uniqueness", (r) => ({ ...r, startsWon: [] }), "colliding starts won the id"],
    [
      "the winning start's input",
      (r) => ({ ...r, startsWon: [{ forged: true }] }),
      "not the winning start's",
    ],
  ])("fires on a run that breaks %s", (_law, doctor, phrase) => {
    expect(checkLaws(PROGRAM, doctor(run), oracle).join("\n")).toContain(phrase);
  });
});
