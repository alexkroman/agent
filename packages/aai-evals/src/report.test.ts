// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  evalShortfalls,
  failureGroups,
  formatEvalReport,
  formatScore,
  signature,
} from "./report.ts";
import { type EvalReport, runEval } from "./runner.ts";

async function report(name: string, repeat: number, body: Parameters<typeof runEval>[0]["body"]) {
  return runEval({ name, repeat, body });
}

describe("signature", () => {
  test("collapses identifiers, numbers and quoted strings", () => {
    expect(signature(`calledTool(x) args — saw {"orderId":"W1234"} at 17`)).toBe(
      'calledTool(x) args — saw {"X":"X"} at N',
    );
  });

  test("collapses a hex id so two instances of one defect group", () => {
    const a = signature("project eval-4f2a91bc3d failed");
    const b = signature("project eval-91cc02da77 failed");
    expect(a).toBe(b);
  });
});

describe("failureGroups", () => {
  test("groups one defect across cases, most common first", async () => {
    const one = await report("case A", 1, async (t) => {
      t.check(false, "endedGreen", "error TS2345: argument of type 'x'");
      t.check(false, "client UI", "no client.tsx");
    });
    const two = await report("case B", 1, async (t) => {
      t.check(false, "endedGreen", "error TS2345: argument of type 'y'");
    });
    const groups = failureGroups([one, two]);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.cases).toEqual(["case A", "case B"]);
    expect(groups).toHaveLength(2);
  });

  test("a passing run groups nothing", async () => {
    const clean = await report("case", 1, async (t) => {
      t.check(true, "fine");
    });
    expect(failureGroups([clean])).toEqual([]);
  });
});

describe("formatScore", () => {
  test("a single pass prints one number, and repeats print the spread", async () => {
    const once = await report("case", 1, async (t) => {
      t.check(true, "a");
    });
    expect(formatScore(once)).toBe("100%");

    let call = 0;
    const thrice = await report("case", 4, async (t) => {
      call += 1;
      t.check(call % 2 === 0, "flips");
      t.check(true, "holds");
    });
    expect(formatScore(thrice)).toBe("75% (50%–100%, ±50%)");
  });
});

describe("formatEvalReport", () => {
  test("names every failing assertion once, plus the unstable ones", async () => {
    let call = 0;
    const flaky = await report("ordering", 2, async (t) => {
      call += 1;
      t.check(call === 1, "toolOrder(a → b)", "called: b → a");
      t.check(false, "saidSomething(refund)", "said: nothing");
    });
    const text = formatEvalReport([flaky]);
    expect(text).toContain("ordering  score 25% (0%–50%, ±50%)  2 repeats");
    expect(text).toContain("FAIL toolOrder(a → b) — called: b → a");
    expect(text).toContain("UNSTABLE across repeats: toolOrder(a → b)");
    expect(text.match(/FAIL saidSomething/g)).toHaveLength(1);
  });

  test("a harness error is reported apart from the assertions", async () => {
    const broken = await report("dead", 1, async (t) => {
      t.check(true, "reached");
      throw new Error("studio unreachable");
    });
    const text = formatEvalReport([broken]);
    expect(text).toContain("HARNESS ERRORS 1");
    expect(text).toContain("HARNESS r1: studio unreachable");
  });

  test("a recurring failure gets its own section, a one-off does not", async () => {
    const a = await report("A", 1, async (t) => {
      t.check(false, "endedGreen", "error TS1: bad");
    });
    const b = await report("B", 1, async (t) => {
      t.check(false, "endedGreen", "error TS1: bad");
    });
    expect(formatEvalReport([a, b])).toContain("RECURRING FAILURES");
    expect(formatEvalReport([a])).not.toContain("RECURRING FAILURES");
  });
});

describe("evalShortfalls", () => {
  const spread = (min: number, max: number): EvalReport => ({
    name: "case",
    passes: [],
    score: { min, max, mean: (min + max) / 2, spread: max - min },
    ms: { min: 0, max: 0, mean: 0, spread: 0 },
    unstable: [],
    harnessErrors: 0,
    measuredPasses: 2,
  });

  test("no floor means no shortfall — the tier reports by default", () => {
    expect(evalShortfalls([spread(0, 0)], undefined)).toEqual([]);
  });

  test("the floor is compared against the WORST repeat, not the mean", () => {
    // mean 0.75 clears 0.7; the worst repeat does not.
    expect(evalShortfalls([spread(0.5, 1)], 0.7)).toEqual(["case: worst repeat 50% < 70%"]);
    expect(evalShortfalls([spread(0.8, 1)], 0.7)).toEqual([]);
  });
});
