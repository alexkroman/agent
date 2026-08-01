// Copyright 2026 the AAI authors. MIT license.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withBuildDir } from "./studio-build.ts";
import { formatTestRun, runWorkspaceTests } from "./studio-test.ts";

/** Materialize a files record into the scratch dir. */
async function materialize(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(dir, rel), content, "utf-8");
  }
}

describe("runWorkspaceTests", () => {
  test("skips a workspace with no test files", async () => {
    const result = await withBuildDir({ "agent.ts": "export default {};\n" }, materialize, (dir) =>
      runWorkspaceTests(dir),
    );
    expect(result).toEqual({ ran: false, reason: "no test files in the workspace" });
  });

  test("runs only the workspace's own tests, never the surrounding repo", {
    timeout: 120_000,
  }, async () => {
    // The guard that matters: workspaces materialize inside this repo in
    // local dev, so an unpinned root would run the whole monorepo suite in
    // the tenant's sandbox.
    const result = await withBuildDir(
      {
        "sample.test.ts": `import { expect, test } from "vitest";
test("one", () => { expect(1).toBe(1); });
`,
      },
      materialize,
      (dir) => runWorkspaceTests(dir),
    );
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.passed).toBe(true);
    expect(result.output).toContain("1 passed");
    // A vitest that escaped would pull in this very file.
    expect(result.output).not.toContain("studio-test.test.ts");
    expect(result.output).not.toContain("studio-build.test.ts");
  });

  test("reports a failing test as output the agent can act on", { timeout: 120_000 }, async () => {
    const result = await withBuildDir(
      {
        "sample.test.ts": `import { expect, test } from "vitest";
test("drifted", () => { expect("cart").toBe("basket"); });
`,
      },
      materialize,
      (dir) => runWorkspaceTests(dir),
    );
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.passed).toBe(false);
    expect(result.output).toContain("drifted");
  });
});

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
