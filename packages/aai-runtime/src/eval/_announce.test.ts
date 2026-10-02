// Copyright 2026 the AAI authors. MIT license.
/** What an eval suite says about itself: its mode, its coverage, and an empty run. */

import { describe, expect, test, vi } from "vitest";
import { announceEvalCoverage, announceEvalMode, emptySuiteReason } from "./_announce.ts";

describe("announceEvalMode", () => {
  /**
   * The one line that separates a wiring check from a behaviour measurement, and
   * nothing asserted it was emitted at all — which is how it came to be dropped
   * on every GREEN `aai eval` run for as long as it had been there. So the claim
   * is the CHANNEL, not the wording: `console.warn` is intercepted by vitest and
   * handed to whichever reporter it resolved, and the one it picks for an AGENT
   * prints a passing file's captured output nowhere. A direct stderr write is
   * what survives any of them.
   */
  test("writes to stderr rather than through the intercepted console", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);

    announceEvalMode("eval: X — SCRIPTED model (reason).");

    expect(warn).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("eval: X — SCRIPTED model (reason).\n");
  });
});

describe("announceEvalCoverage", () => {
  /**
   * The counts nothing else reports. Vitest prints `2 skipped` per FILE and
   * `aai eval --json` answers `{"passed":true}` with no counts at all, so a
   * suite whose every case is live-only read as a green run — see
   * {@link emptySuiteReason}.
   */
  test("says how many of the suite's cases this mode will run", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceEvalCoverage("Desk", "stub", 3, 1);
    expect(stderr).toHaveBeenCalledWith(
      "eval: Desk — 2 of 3 case(s) run against the scripted model; 1 skipped as live-only.\n",
    );
  });

  test("an all-ran suite still gets a line — a number that hides is not read", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceEvalCoverage("Desk", "live", 2, 0);
    expect(stderr).toHaveBeenCalledWith(
      "eval: Desk — 2 of 2 case(s) run against the live model.\n",
    );
  });
});

describe("emptySuiteReason", () => {
  test("a suite whose every case is skipped by the mode gate FAILS", () => {
    // Measured on a scaffolded project: two `{ live: true }` cases with no key
    // printed `2 skipped`, `{"ok":true,"data":{"passed":true}}` and exited 0.
    const reason = emptySuiteReason("stub", 2, 2);
    expect(reason).toContain("{ live: true }");
    expect(reason).toContain("measured nothing");
    expect(reason).toContain("stubReply");
  });

  test("the mirror: an all-scripted suite on a live model", () => {
    expect(emptySuiteReason("live", 3, 3)).toContain("{ scripted: true }");
  });

  test("one runnable case is enough — the gate is 'nothing ran', not 'few ran'", () => {
    expect(emptySuiteReason("stub", 3, 2)).toBeUndefined();
  });

  test("a suite that declared nothing is left to vitest, which already fails it", () => {
    expect(emptySuiteReason("stub", 0, 0)).toBeUndefined();
  });
});
