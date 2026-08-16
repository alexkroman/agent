// Copyright 2026 the AAI authors. MIT license.
// `formatTestRun`, UNIT tier: pure prose assembly over a `TestRunResult`.
// The runs that PRODUCE one write files and spawn vitest, so they are the
// scenario tier's — `studio-test.scenario.test.ts`.

import { describe, expect, test } from "vitest";
import { formatTestRun } from "./studio-test.ts";

describe("formatTestRun", () => {
  test("a skip never reads as a failure", () => {
    expect(formatTestRun({ ran: false, reason: "no test files in the workspace" })).toBe(
      "Tests: skipped (no test files in the workspace).",
    );
  });

  test("a failure tells the agent both repairs are legitimate", () => {
    // Drift usually means the test is stale, not that the agent is wrong —
    // saying so keeps it from "fixing" working code to satisfy a sample test.
    const text = formatTestRun({ ran: true, passed: false, output: "1 failed" });
    expect(text).toContain("FAILED");
    expect(text).toMatch(/update them to match/i);
  });
});
