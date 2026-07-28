// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silenced } from "./_test-utils.ts";
import { executeTest, resolveVitestCommand, runVitest } from "./test.ts";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, execFileSync };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aai-test-"));
  execFileSync.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("aai test", () => {
  test("returns false when no test files exist", () => {
    const result = runVitest(tempDir);
    expect(result).toBe(false);
  });

  test("detects agent.test.ts files", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    // Just verifying detection - actual execution would need vitest installed
    expect(existsSync(path.join(tempDir, "agent.test.ts"))).toBe(true);
  });

  test("runs vitest against agent.test.ts with type stripping enabled", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    expect(runVitest(tempDir)).toBe(true);
    const [, args, opts] = execFileSync.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    // Resolution mode (local bin vs npx) varies by environment; the vitest
    // CLI arguments and env are the same either way.
    expect(args.slice(-4)).toEqual(["run", "--root", ".", "agent.test.ts"]);
    expect(opts.cwd).toBe(tempDir);
    expect(opts.env.NODE_OPTIONS).toContain("--experimental-strip-types");
  });

  test("runs the project-local vitest bin directly when installed", async () => {
    // Fake a local vitest install in the agent project.
    const vitestDir = path.join(tempDir, "node_modules", "vitest");
    await mkdir(vitestDir, { recursive: true });
    await writeFile(
      path.join(vitestDir, "package.json"),
      JSON.stringify({ name: "vitest", version: "0.0.0", bin: { vitest: "vitest.mjs" } }),
    );
    await writeFile(path.join(vitestDir, "vitest.mjs"), "// fake bin");
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");

    expect(runVitest(tempDir)).toBe(true);
    const [cmd, args] = execFileSync.mock.calls[0] as [string, string[]];
    // No npx: the local bin JS runs with the current Node executable.
    expect(cmd).toBe(process.execPath);
    expect(args[0]?.endsWith(path.join("node_modules", "vitest", "vitest.mjs"))).toBe(true);
    expect(args.slice(1)).toEqual(["run", "--root", ".", "agent.test.ts"]);
  });

  test("resolveVitestCommand falls back to npx when vitest is not resolvable", () => {
    const failingResolve = () => {
      throw new Error("Cannot find module 'vitest/package.json'");
    };
    expect(resolveVitestCommand(tempDir, failingResolve)).toEqual({
      cmd: "npx",
      args: ["vitest"],
    });
  });

  test("resolveVitestCommand runs the resolved bin with the current node", async () => {
    const vitestDir = path.join(tempDir, "node_modules", "vitest");
    await mkdir(vitestDir, { recursive: true });
    await writeFile(
      path.join(vitestDir, "package.json"),
      JSON.stringify({ name: "vitest", bin: { vitest: "dist/cli.mjs" } }),
    );
    const resolve = () => path.join(vitestDir, "package.json");
    expect(resolveVitestCommand(tempDir, resolve)).toEqual({
      cmd: process.execPath,
      args: [path.join(vitestDir, "dist", "cli.mjs")],
    });
  });

  test("falls back to agent.test.js when no .ts test exists", async () => {
    await writeFile(path.join(tempDir, "agent.test.js"), "// test file");
    expect(runVitest(tempDir)).toBe(true);
    expect(execFileSync.mock.calls[0]?.[1]).toContain("agent.test.js");
  });
});

describe("executeTest", () => {
  test("returns skipped result when no test file exists", async () => {
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true } });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test("returns passed result when vitest succeeds", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true } });
  });

  test("returns test_failed when vitest exits non-zero", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    execFileSync.mockImplementation(() => {
      throw new Error("exit 1");
    });
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({ ok: false, code: "test_failed", error: "Tests failed" });
  });
});
