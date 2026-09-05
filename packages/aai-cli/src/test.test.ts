// Copyright 2025 the AAI authors. MIT license.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silenced } from "./_test-utils.ts";
import { executeTest } from "./test.ts";

const execaSync = vi.hoisted(() => vi.fn());
vi.mock("execa", async (importOriginal) => {
  const orig = await importOriginal<typeof import("execa")>();
  return { ...orig, execaSync };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aai-test-"));
  // A factory `vi.fn()` rather than a spy, so `restoreMocks` does not reach it
  // and its call history would otherwise be cumulative across this file.
  execaSync.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("executeTest", () => {
  test("returns skipped result when the project has no specs at all", async () => {
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({
      ok: true,
      data: { passed: true, skipped: true, ran: [], unrun: [], complete: true },
    });
    expect(execaSync).not.toHaveBeenCalled();
  });

  test("a project with ONLY co-located specs FAILS rather than reporting a pass", async () => {
    // The arm that misled longest: `aai test` printed "No test file found" while
    // the project's specs sat right there unrun, and answered
    // `{"passed":true,"skipped":true}` with exit 0 — which in CI reads as a
    // passing suite. Measured on a real project whose only spec was
    // `tools/echo_back.test.ts`.
    await mkdir(path.join(tempDir, "tools"), { recursive: true });
    await writeFile(path.join(tempDir, "tools", "echo_back.test.ts"), "");
    const result = await silenced(() => executeTest(tempDir))(tempDir);

    expect(result.ok).toBe(false);
    if (result.ok) expect.fail("an unrun spec must not be a passing result");
    expect(result.code).toBe("incomplete_run");
    expect(result.error).toContain("tools/echo_back.test.ts");
    expect(result.hint).toContain("aai test --all");
    expect(execaSync).not.toHaveBeenCalled();
  });

  test("a narrowed run over a project with other specs is NOT a pass", async () => {
    // The reproduction from the field: one tool added to the `retail` template
    // broke `registry.test.ts` in 17 assertions while `pnpm test` and
    // `pnpm build` stayed green, because the scaffold wires `"test": "aai test"`
    // and `aai test` ran `agent.test.ts` alone and exited 0.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "registry.test.ts"), "");
    const result = await silenced(() => executeTest(tempDir))(tempDir);

    if (result.ok) expect.fail("a narrowed run must not be a passing result");
    expect(result.code).toBe("incomplete_run");
    expect(result.error).toBe(
      "`aai test` ran agent.test.ts only — 1 other spec file(s) in this project were not run: " +
        "registry.test.ts. An unrun spec is not a passing one, so this is not a green result.",
    );
    expect(result.hint).toContain("aai test --all");
    // It still RAN what it could: the failure is the verdict, not a refusal to
    // test. A reader gets vitest's own report and then why it is not enough.
    expect(execaSync).toHaveBeenCalledTimes(1);
  });

  test("the failure names at most ten specs and counts the rest", async () => {
    // A project may hold hundreds; the message has to stay readable.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    for (let i = 0; i < 12; i++) {
      await writeFile(path.join(tempDir, `s${String(i).padStart(2, "0")}.test.ts`), "");
    }
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    if (result.ok) expect.fail("12 unrun specs must not be a passing result");
    expect(result.error).toContain("and 2 more");
    expect(result.error).not.toContain("s11.test.ts");
  });

  test("--all widens the run and makes the verdict complete", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "registry.test.ts"), "");
    const result = await silenced(() => executeTest(tempDir, { all: true }))(tempDir);
    expect(result).toEqual({
      ok: true,
      data: {
        passed: true,
        ran: ["agent.test.ts", "registry.test.ts"],
        unrun: [],
        complete: true,
      },
    });
  });

  test("a passing complete run reports the set it covered", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({
      ok: true,
      data: { passed: true, ran: ["agent.test.ts"], unrun: [], complete: true },
    });
  });

  test("returns test_failed with detail when vitest exits non-zero", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    execaSync.mockImplementation(() => {
      throw new Error("exit 1");
    });
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({ ok: false, code: "test_failed", error: "Tests failed: exit 1" });
  });

  test("returns spawn_failed when the test runner binary is missing", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    execaSync.mockImplementation(() => {
      const err = new Error("spawnSync npx ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({
      ok: false,
      code: "spawn_failed",
      error: "Could not launch the test runner: spawnSync npx ENOENT — is the binary on your PATH?",
    });
  });
});
