// Copyright 2026 the AAI authors. MIT license.
/**
 * The repeat runner's verdict, and the line it prints.
 *
 * Asserted HERE rather than through a template eval, which is where this got
 * its first exercise: driving it that way needs a live model to disagree with
 * itself, so the one behaviour worth pinning — a case that failed SOME repeats
 * passes, and one that failed EVERY repeat fails — was reachable only by luck.
 *
 * `SuiteSpread.report()` registers an `afterAll`, so the line it writes is
 * asserted through a fake registrar rather than by running a suite.
 */

import { describe, expect, test, vi } from "vitest";
import { runRepeats, SuiteSpread } from "./_spread.ts";

/** A body that fails on the repeats named, and passes on the rest. */
function failingOn(...attempts: readonly number[]): () => Promise<void> {
  let n = 0;
  return async () => {
    n += 1;
    await Promise.resolve();
    if (attempts.includes(n)) throw new Error(`attempt ${n} failed`);
  };
}

describe("runRepeats", () => {
  test("runs the body exactly `repeat` times", async () => {
    const run = vi.fn(async () => {
      await Promise.resolve();
    });
    await runRepeats(run, "steady", 3, new SuiteSpread("s"));
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("a case that failed EVERY repeat fails, with its FIRST error", async () => {
    // The first, not the last: a case that fails every time has one story, and
    // the earliest telling has not been walked over by a later teardown.
    await expect(runRepeats(failingOn(1, 2), "broken", 2, new SuiteSpread("s"))).rejects.toThrow(
      "attempt 1 failed",
    );
  });

  test("a case that failed SOME repeats PASSES — it is a coin toss, not a defect", async () => {
    // The whole point of the mechanism. Reverting this line is how a noisy live
    // tier goes back to failing a merge over variance.
    await expect(
      runRepeats(failingOn(2), "flaky", 3, new SuiteSpread("s")),
    ).resolves.toBeUndefined();
  });

  test("still runs every repeat after one fails, so the rate is honest", async () => {
    const run = vi.fn(failingOn(1));
    await runRepeats(run, "flaky", 4, new SuiteSpread("s"));
    expect(run).toHaveBeenCalledTimes(4);
  });

  test("a body that throws `undefined` is a FAILURE, not a pass", async () => {
    // `undefined` is the tally's own spelling of "passed", so a body that threw
    // it would otherwise be counted green.
    await expect(
      // A REJECTION rather than a `throw undefined` statement, which Biome's
      // `useThrowOnlyError` rejects — rightly, even here. The runner sees the
      // same thing either way: an `undefined` reason.
      runRepeats(() => Promise.reject(undefined), "weird", 1, new SuiteSpread("s")),
    ).rejects.toThrow(/threw undefined/);
  });
});

describe("SuiteSpread.report", () => {
  /** Run `body`, then fire the `afterAll` it registered, and return the lines. */
  async function reportedLines(body: (spread: SuiteSpread) => Promise<void>): Promise<string[]> {
    const hooks: (() => void)[] = [];
    const afterAll = vi.fn((fn: () => void) => void hooks.push(fn));
    vi.doMock("vitest", async () => ({
      ...(await vi.importActual<typeof import("vitest")>("vitest")),
      afterAll,
    }));
    vi.resetModules();
    const mod = await import("./_spread.ts");
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    try {
      const spread = new mod.SuiteSpread("Desk");
      await body(spread);
      spread.report();
      for (const fn of hooks) fn();
    } finally {
      stderr.mockRestore();
      vi.doUnmock("vitest");
      vi.resetModules();
    }
    return lines;
  }

  test("says nothing when nothing repeated — an unset environment is untouched", async () => {
    const lines = await reportedLines(async (spread) => {
      await runRepeats(failingOn(), "once", 1, spread);
    });
    expect(lines).toEqual([]);
  });

  test("reports every case unanimous when none disagreed", async () => {
    const lines = await reportedLines(async (spread) => {
      await runRepeats(failingOn(), "a", 2, spread);
      await runRepeats(failingOn(), "b", 2, spread);
    });
    expect(lines.join("\n")).toMatch(/Desk — 2 repeats of 2 case\(s\); every case unanimous\./);
  });

  test("names the unstable case, its RATE, and the failure it saw", async () => {
    // The rate alone said a case was a coin toss and nothing about which way it
    // landed — and vitest prints nothing for a case that passed overall, so a
    // reader knew there was something to fix and not what.
    const lines = await reportedLines(async (spread) => {
      await runRepeats(failingOn(2), "flaky one", 2, spread);
    });
    const text = lines.join("\n");
    expect(text).toMatch(/1 UNSTABLE \(a pass rate, and the failure each one saw\):/);
    expect(text).toMatch(/flaky one \(1\/2\): attempt 2 failed/);
  });

  test("a unanimously FAILED case is not reported as unstable — it is a finding", async () => {
    const lines = await reportedLines(async (spread) => {
      await runRepeats(failingOn(1, 2), "broken", 2, spread).catch(() => undefined);
    });
    expect(lines.join("\n")).toMatch(/every case unanimous\./);
  });
});
