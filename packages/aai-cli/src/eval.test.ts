// Copyright 2026 the AAI authors. MIT license.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { invocation, test } from "./_vitest-runner-test-utils.ts";
import { EVAL_TEST_TIMEOUT_MS, executeEval } from "./eval.ts";

describe("executeEval", () => {
  test("skips, saying what to create, when the project has no eval file", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    const result = await executeEval(tmpDir, deps);
    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true, ran: [] } });
    expect(exec).not.toHaveBeenCalled();
  });

  test("does not pick up the unit test file — the two commands are disjoint", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// unit test");
    const result = await executeEval(tmpDir, deps);
    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true, ran: [] } });
    expect(exec).not.toHaveBeenCalled();
  });

  test("runs agent.eval.test.ts with a budget a live model turn can meet", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "// eval file");
    const result = await executeEval(tmpDir, deps);
    expect(result).toEqual({ ok: true, data: { passed: true, ran: ["agent.eval.test.ts"] } });
    const { args, opts } = invocation(exec);
    expect(args.slice(-6)).toEqual([
      "run",
      "--root",
      ".",
      "--testTimeout",
      String(EVAL_TEST_TIMEOUT_MS),
      "agent.eval.test.ts",
    ]);
    expect(opts.cwd).toBe(tmpDir);
    // Vitest's 5s default is shorter than one live model turn, so the flag is
    // the difference between measuring the agent and reporting a timeout.
    expect(EVAL_TEST_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  test("hands the project's .env to the eval, since that is where the key lives", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "// eval file");
    await writeFile(path.join(tmpDir, ".env"), "ASSEMBLYAI_API_KEY=from-dot-env\n");
    await executeEval(tmpDir, deps);
    const { opts } = invocation(exec);
    expect(opts.env?.ASSEMBLYAI_API_KEY).toBe("from-dot-env");
    // The rest of the parent environment is still inherited — a key exported in
    // the shell has to keep working too.
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });

  test("falls back to agent.eval.test.js", async ({ tmpDir, deps, exec }) => {
    await writeFile(path.join(tmpDir, "agent.eval.test.js"), "// eval file");
    await executeEval(tmpDir, deps);
    expect(invocation(exec).args.at(-1)).toBe("agent.eval.test.js");
  });

  test("reports a failed eval as an eval failure, not a test failure", async ({
    tmpDir,
    exec,
    deps,
  }) => {
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "// eval file");
    exec.mockImplementation(() => {
      throw new Error("exit 1");
    });
    const result = await executeEval(tmpDir, deps);
    expect(result).toEqual({ ok: false, code: "test_failed", error: "Evals failed: exit 1" });
  });

  test("an eval run never names the project's unit specs as skipped", async ({
    tmpDir,
    deps,
    notify,
  }) => {
    // `unrunSpecFiles` drops eval files by infix, so the notice `aai build`
    // gets from `runVitest` would, left on here, list every unit spec in the
    // project as "NOT run" during `aai eval`. True and not this command's
    // business — `aai test` is what reports and refuses that set.
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "// eval file");
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// unit test");
    await writeFile(path.join(tmpDir, "store.test.ts"), "// unit test");
    await executeEval(tmpDir, deps);
    expect(notify).not.toHaveBeenCalled();
  });

  test("reports a runner that could not be spawned as infrastructure", async ({
    tmpDir,
    exec,
    deps,
  }) => {
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "// eval file");
    exec.mockImplementation(() => {
      const err = new Error("spawnSync npx ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await executeEval(tmpDir, deps);
    expect(result).toMatchObject({ ok: false, code: "spawn_failed" });
  });
});
