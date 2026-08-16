// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { formatSpread } from "./report.ts";
import { evalMinScore, evalRepeat, runEval } from "./runner.ts";

describe("runEval", () => {
  test("records every assertion rather than stopping at the first failure", async () => {
    const report = await runEval({
      name: "case",
      repeat: 1,
      body: async (t) => {
        t.check(false, "first", "saw nothing");
        t.check(true, "second");
        t.check(false, "third");
      },
    });
    expect(report.passes[0]?.checks.map((c) => c.label)).toEqual(["first", "second", "third"]);
    expect(report.score.mean).toBeCloseTo(1 / 3);
  });

  test("keeps a failure's detail and drops it for a passing check", async () => {
    const report = await runEval({
      name: "case",
      repeat: 1,
      body: async (t) => {
        t.check(false, "bad", "because X");
        t.check(true, "good", "unused");
      },
    });
    expect(report.passes[0]?.checks).toEqual([
      { label: "bad", ok: false, detail: "because X" },
      { label: "good", ok: true },
    ]);
  });

  test("reports a spread over repeats", async () => {
    let call = 0;
    const report = await runEval({
      name: "case",
      repeat: 4,
      body: async (t) => {
        call += 1;
        t.check(call % 2 === 0, "flips");
        t.check(true, "holds");
      },
    });
    expect(report.passes).toHaveLength(4);
    expect(report.score.min).toBe(0.5);
    expect(report.score.max).toBe(1);
    expect(report.score.spread).toBe(0.5);
    expect(report.score.mean).toBe(0.75);
  });

  test("names the assertions that were not unanimous, and only those", async () => {
    let call = 0;
    const report = await runEval({
      name: "case",
      repeat: 3,
      body: async (t) => {
        call += 1;
        t.check(call === 1, "sometimes");
        t.check(true, "always");
        t.check(false, "never");
      },
    });
    expect(report.unstable).toEqual(["sometimes"]);
  });

  test("unstable labels sort by CODE UNIT, not by locale", async () => {
    // `localeCompare` with no explicit locale answers to the runtime's ICU
    // default, so the same run would print a different order on a different
    // machine — and this list goes into a committed report. These four are
    // chosen because locale collation and code-unit order DISAGREE on them:
    // a locale-aware sort ignores case and puts "a" before "B", while code
    // units put every uppercase letter first. Asserting the code-unit answer
    // is what makes the ordering a property of the data rather than the box.
    let call = 0;
    // `await`, not a returned `.then` — the only test in this file written that
    // way. It worked because the promise was returned, which is exactly the
    // fragility: drop the `return` and the assertion moves out of the test, the
    // body passes having checked nothing, and a failure surfaces as an
    // unhandled rejection attributed to whatever ran next.
    const report = await runEval({
      name: "case",
      repeat: 2,
      body: async (t) => {
        call += 1;
        const flips = call === 1;
        for (const label of ["b", "B", "a", "A"]) t.check(flips, label);
      },
    });
    expect(report.unstable).toEqual(["A", "B", "a", "b"]);
  });

  test("a harness failure is recorded on its pass and does not lose the others", async () => {
    let call = 0;
    const report = await runEval({
      name: "case",
      repeat: 3,
      body: async (t) => {
        call += 1;
        t.check(true, "reached");
        if (call === 2) throw new Error("sandbox died");
      },
    });
    expect(report.harnessErrors).toBe(1);
    expect(report.passes[1]?.error).toContain("sandbox died");
    expect(report.passes.map((p) => p.checks.length)).toEqual([1, 1, 1]);
  });

  test("a harness failure is kept OUT of the score and the spread", async () => {
    // The pass that dies here has recorded one passing check, so it scores 1.0.
    // Averaged in, a dead sandbox would RAISE the reported score and set
    // `score.max` — the "averaging the two hides both" failure `EvalPass.error`
    // documents, applied to the number the tier is read for.
    let call = 0;
    const report = await runEval({
      name: "case",
      repeat: 2,
      body: async (t) => {
        call += 1;
        t.check(true, "reached");
        if (call === 2) throw new Error("sandbox died");
        t.check(false, "second");
      },
    });
    expect(report.harnessErrors).toBe(1);
    expect(report.measuredPasses).toBe(1);
    // Only the surviving pass: one of two checks held.
    expect(report.score).toEqual({ min: 0.5, max: 0.5, mean: 0.5, spread: 0 });
  });

  test("every pass dying is NO measurement, reported as such", async () => {
    const report = await runEval({
      name: "case",
      repeat: 2,
      body: async () => {
        throw new Error("sandbox died");
      },
    });
    expect(report.measuredPasses).toBe(0);
    expect(report.harnessErrors).toBe(2);
    expect(formatSpread(report)).toBe("not measured");
  });

  test("an unreached assertion is missing data, not a flip", async () => {
    let call = 0;
    const report = await runEval({
      name: "case",
      repeat: 2,
      body: async (t) => {
        call += 1;
        t.check(true, "early");
        if (call === 1) throw new Error("stop");
        t.check(true, "late");
      },
    });
    expect(report.unstable).toEqual([]);
  });

  test("a case that asserts nothing scores zero rather than one", async () => {
    const report = await runEval({ name: "empty", repeat: 1, body: async () => undefined });
    expect(report.score.mean).toBe(0);
  });

  test("never throws for a failed assertion", async () => {
    await expect(
      runEval({
        name: "case",
        repeat: 1,
        body: async (t) => {
          t.check(false, "everything");
        },
      }),
    ).resolves.toMatchObject({ score: { mean: 0 } });
  });
});

describe("evalRepeat", () => {
  test("defaults to one and reads AAI_EVAL_REPEAT", () => {
    expect(evalRepeat({})).toBe(1);
    expect(evalRepeat({ AAI_EVAL_REPEAT: "" })).toBe(1);
    expect(evalRepeat({ AAI_EVAL_REPEAT: "5" })).toBe(5);
  });

  test("refuses a value that would silently run nothing", () => {
    expect(() => evalRepeat({ AAI_EVAL_REPEAT: "three" })).toThrow(/positive integer/);
    expect(() => evalRepeat({ AAI_EVAL_REPEAT: "0" })).toThrow(/positive integer/);
  });
});

describe("evalMinScore", () => {
  test("is absent unless asked for, so the tier reports rather than gates", () => {
    expect(evalMinScore({})).toBeUndefined();
    expect(evalMinScore({ AAI_EVAL_MIN_SCORE: "" })).toBeUndefined();
    expect(evalMinScore({ AAI_EVAL_MIN_SCORE: "0.8" })).toBe(0.8);
  });

  test("refuses a value outside 0..1", () => {
    expect(() => evalMinScore({ AAI_EVAL_MIN_SCORE: "80" })).toThrow(/between 0 and 1/);
    expect(() => evalMinScore({ AAI_EVAL_MIN_SCORE: "-1" })).toThrow(/between 0 and 1/);
  });
});
