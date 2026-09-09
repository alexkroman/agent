// Copyright 2026 the AAI authors. MIT license.
// `runWorkspaceTests`, SCENARIO tier: it writes a workspace and spawns a real
// vitest, which is what puts it here. `formatTestRun` is pure prose assembly
// and stays in the unit tier — `studio-test.test.ts`.

import { describe, expect, test, vi } from "vitest";
import { materialize } from "./_test-utils.ts";
import { withBuildDir } from "./studio-build.ts";
import { runWorkspaceTests } from "./studio-test.ts";

describe("runWorkspaceTests", () => {
  test("skips a workspace with no test files", async () => {
    const result = await withBuildDir({ "agent.ts": "export default {};\n" }, materialize, (dir) =>
      runWorkspaceTests(dir),
    );
    expect(result).toEqual({ ran: false, reason: "no test files in the workspace" });
  });

  test("runs only the workspace's own tests, never the surrounding repo", async () => {
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
    expect(result.passed, result.output).toBe(true);
    expect(result.output).toContain("1 passed");
    // A vitest that escaped would pull in this very file. The names have to
    // track the files: they were `studio-{test,build}.test.ts` until these two
    // moved into the scenario tier, and a substring that names no file on disk
    // is an assertion that cannot fail.
    expect(result.output).not.toContain("studio-test.scenario.test.ts");
    expect(result.output).not.toContain("studio-build.scenario.test.ts");
  });

  // The files vitest runs here are the coding agent's own. Every other guest
  // spawn that executes workspace-authored code scrubs the control-channel
  // bearer (`bash`, `runNpm`, the deploy CLI); this was the one that did not.
  test("workspace-authored tests never see the control-channel bearer", async () => {
    vi.stubEnv("AAI_GUEST_TOKEN", "host-bearer-that-must-not-leak");
    const result = await withBuildDir(
      {
        "sample.test.ts": `import { expect, test } from "vitest";
test("no host bearer", () => { expect(process.env.AAI_GUEST_TOKEN).toBeUndefined(); });
`,
      },
      materialize,
      (dir) => runWorkspaceTests(dir),
    );
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.passed, result.output).toBe(true);
  });

  // The eval tier is `aai test`'s to exclude and was not this runner's, which
  // made `test_agent` grade a workspace on a strictly larger set than the
  // project's own `npm test` runs. Both halves are asserted, because the
  // discovery predicate and the spawn were independently wrong: dropping the
  // file from `testFiles` does nothing on its own, since an unfiltered
  // `vitest run` applies its own include glob and finds it anyway.
  test("never runs the eval tier — it neither gates nor can adjudicate here", async () => {
    const result = await withBuildDir(
      {
        "agent.test.ts": `import { expect, test } from "vitest";
test("the unit spec", () => { expect(1).toBe(1); });
`,
        // FAILS if it is ever collected, which is what makes this sharp: a
        // green run is evidence the file was not reached, where a passing
        // fixture would be evidence of nothing.
        "agent.eval.test.ts": `import { expect, test } from "vitest";
test("the eval that must not run", () => { expect("scripted").toBe("live"); });
`,
      },
      materialize,
      (dir) => runWorkspaceTests(dir),
    );
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.passed, result.output).toBe(true);
    // ONE file, and the count is the assertion rather than the name: the
    // reporter this spawn resolves prints a dot per file, so `not.toContain`
    // over a filename is an assertion that cannot fail. Collected, the eval
    // would read `1 failed | 1 passed (2)`.
    expect(result.output, result.output).toMatch(/Test Files\s+1 passed \(1\)/);
  });

  test("a workspace holding only an eval has no tests to run", async () => {
    // Not merely the mirror of the case above: `testFiles` matched
    // `.test.tsx?$`, so this workspace reported `ran: true` — and `test_agent`
    // told the coding agent its tests had passed on the strength of a scripted
    // eval run.
    const result = await withBuildDir(
      {
        "agent.eval.test.ts": `import { expect, test } from "vitest";
test("the eval", () => { expect(1).toBe(1); });
`,
      },
      materialize,
      (dir) => runWorkspaceTests(dir),
    );
    expect(result).toEqual({ ran: false, reason: "no test files in the workspace" });
  });

  test("reports a failing test as output the agent can act on", async () => {
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
