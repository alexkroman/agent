// Copyright 2025 the AAI authors. MIT license.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { invocation, test } from "./_vitest-runner-test-utils.ts";
import { executeTest } from "./test.ts";

describe("executeTest", () => {
  test("returns skipped result when the project has no specs at all", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    const result = await executeTest(tmpDir, {}, deps);
    expect(result).toEqual({
      ok: true,
      data: { passed: true, skipped: true, ran: [], unrun: [], complete: true },
    });
    expect(exec).not.toHaveBeenCalled();
  });

  test("the DEFAULT run covers every non-eval spec in the project", async ({
    tmpDir,
    deps,
    exec,
    notify,
  }) => {
    // The regression this file exists to hold, and the one it missed for
    // several releases: `aai test` ran `agent.test.ts` and then FAILED over
    // everything else, so on any project with a second spec file the default
    // invocation could not be green — nine shipped templates carry two or
    // more, and the scaffold routed around the command by wiring plain vitest
    // into `npm test`.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "registry.test.ts"), "");
    await mkdir(path.join(tmpDir, "tools"), { recursive: true });
    await writeFile(path.join(tmpDir, "tools", "swap.test.ts"), "");
    // Evals have their own command; the widened run must not reach them.
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "");

    const result = await executeTest(tmpDir, {}, deps);

    expect(result).toEqual({
      ok: true,
      data: {
        passed: true,
        ran: ["agent.test.ts", "registry.test.ts", "tools/swap.test.ts"],
        unrun: [],
        complete: true,
      },
    });
    expect(invocation(exec).args.slice(-3)).toEqual([
      "agent.test.ts",
      "registry.test.ts",
      "tools/swap.test.ts",
    ]);
    // Nothing was skipped, so there is nothing to warn about.
    expect(notify).not.toHaveBeenCalled();
  });

  test("--only narrows the run and WARNS about the rest instead of failing", async ({
    tmpDir,
    deps,
    exec,
    notify,
  }) => {
    // The fast inner loop `TEST_FILES` was written for, minus the false
    // verdict: an author who asked for one file gets vitest's own summary and
    // then the files that loop did not reach, and the result says
    // `complete: false` for anything reading it.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "registry.test.ts"), "");

    const result = await executeTest(tmpDir, { only: true }, deps);

    expect(result).toEqual({
      ok: true,
      data: {
        passed: true,
        ran: ["agent.test.ts"],
        unrun: ["registry.test.ts"],
        complete: false,
      },
    });
    expect(invocation(exec).args.at(-1)).toBe("agent.test.ts");
    const [level, message] = notify.mock.calls.at(-1) ?? [];
    expect(level).toBe("warn");
    expect(message).toContain("registry.test.ts");
    // The remedy is to stop narrowing, not a flag that no longer exists.
    expect(message).toContain("aai test");
  });

  test("a project with ONLY co-located specs is RUN, not reported as testless", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    // The arm that misled longest, seen from the other side: with no
    // `agent.test.ts` the command printed "No test file found" while the
    // project's specs sat right there. The default now runs them.
    await mkdir(path.join(tmpDir, "tools"), { recursive: true });
    await writeFile(path.join(tmpDir, "tools", "echo_back.test.ts"), "");

    const result = await executeTest(tmpDir, {}, deps);

    expect(result).toEqual({
      ok: true,
      data: { passed: true, ran: ["tools/echo_back.test.ts"], unrun: [], complete: true },
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("--only with no agent.test.ts FAILS rather than reporting a pass", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    // `{"passed":true,"skipped":true}` with exit 0 over a project whose only
    // spec was `tools/echo_back.test.ts` is what this arm used to answer, and
    // in CI that reads as a passing suite. A deliberate `--only` in a project
    // with no `agent.test.ts` asked for a file that is not there, so it is
    // neither a pass nor silence.
    await mkdir(path.join(tmpDir, "tools"), { recursive: true });
    await writeFile(path.join(tmpDir, "tools", "echo_back.test.ts"), "");
    const result = await executeTest(tmpDir, { only: true }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) expect.fail("an unrun spec must not be a passing result");
    expect(result.code).toBe("incomplete_run");
    expect(result.error).toContain("tools/echo_back.test.ts");
    expect(result.hint).toContain("aai test");
    expect(exec).not.toHaveBeenCalled();
  });

  test("the failure names at most ten specs and counts the rest", async ({ tmpDir, deps }) => {
    // A project may hold hundreds; the message has to stay readable.
    for (let i = 0; i < 12; i++) {
      await writeFile(path.join(tmpDir, `s${String(i).padStart(2, "0")}.test.ts`), "");
    }
    const result = await executeTest(tmpDir, { only: true }, deps);
    if (result.ok) expect.fail("12 unrun specs must not be a passing result");
    expect(result.error).toContain("and 2 more");
    expect(result.error).not.toContain("s11.test.ts");
  });

  test("a passing single-spec run reports the set it covered", async ({ tmpDir, deps }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");
    const result = await executeTest(tmpDir, {}, deps);
    expect(result).toEqual({
      ok: true,
      data: { passed: true, ran: ["agent.test.ts"], unrun: [], complete: true },
    });
  });

  test("returns test_failed with detail when vitest exits non-zero", async ({
    tmpDir,
    exec,
    deps,
  }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");
    exec.mockImplementation(() => {
      throw new Error("exit 1");
    });
    const result = await executeTest(tmpDir, {}, deps);
    expect(result).toEqual({ ok: false, code: "test_failed", error: "Tests failed: exit 1" });
  });

  test("returns spawn_failed when the test runner binary is missing", async ({
    tmpDir,
    exec,
    deps,
  }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");
    exec.mockImplementation(() => {
      const err = new Error("spawnSync npx ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await executeTest(tmpDir, {}, deps);
    expect(result).toEqual({
      ok: false,
      code: "spawn_failed",
      error: "Could not launch the test runner: spawnSync npx ENOENT — is the binary on your PATH?",
    });
  });
});
