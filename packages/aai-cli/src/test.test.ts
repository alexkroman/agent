// Copyright 2025 the AAI authors. MIT license.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silenced } from "./_test-utils.ts";
import { executeTest, resolveVitestCommand, runVitest, unrunSpecFiles } from "./test.ts";

const execaSync = vi.hoisted(() => vi.fn());
vi.mock("execa", async (importOriginal) => {
  const orig = await importOriginal<typeof import("execa")>();
  return { ...orig, execaSync };
});

/**
 * `notify` is the channel the unrun-spec warning goes out on, so a spec that
 * asserts the warning has to watch it rather than the console `log` writes to.
 */
const notify = vi.hoisted(() => vi.fn());
vi.mock("./_ui.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./_ui.ts")>();
  return { ...orig, notify };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aai-test-"));
  execaSync.mockReset();
  notify.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("aai test", () => {
  test("returns false when no test files exist", () => {
    const result = runVitest(tempDir);
    expect(result).toBe(false);
  });

  test("detects agent.test.js when there is no agent.test.ts", async () => {
    // This used to assert `existsSync` on the file it had itself just written,
    // so it passed with `test.ts` deleted. The `.js` arm is the half of
    // `runVitest`'s detection the `.ts` test below does not reach.
    await writeFile(path.join(tempDir, "agent.test.js"), "// test file");
    // The NAME it ran, not a boolean — the caller reports it and
    // `warnUnrunSpecs` reports the complement.
    expect(runVitest(tempDir)).toBe("agent.test.js");
    const [, args] = execaSync.mock.calls[0] as [string, string[]];
    expect(args.at(-1)).toBe("agent.test.js");
  });

  test("runs vitest against agent.test.ts without overriding NODE_OPTIONS", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    expect(runVitest(tempDir)).toBe("agent.test.ts");
    const [, args, opts] = execaSync.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env?: Record<string, string> },
    ];
    // Resolution mode (local bin vs npx) varies by environment; the vitest
    // CLI arguments and env are the same either way.
    expect(args.slice(-4)).toEqual(["run", "--root", ".", "agent.test.ts"]);
    expect(opts.cwd).toBe(tempDir);
    // Type stripping is default-on for every supported Node, so the child
    // inherits the parent env untouched — no NODE_OPTIONS to propagate into
    // vitest's workers.
    expect(opts.env).toBeUndefined();
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

    expect(runVitest(tempDir)).toBe("agent.test.ts");
    const [cmd, args] = execaSync.mock.calls[0] as [string, string[]];
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
    expect(runVitest(tempDir)).toBe("agent.test.js");
    expect(execaSync.mock.calls[0]?.[1]).toContain("agent.test.js");
  });
});

describe("executeTest", () => {
  test("returns skipped result when no test file exists", async () => {
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true } });
    expect(execaSync).not.toHaveBeenCalled();
  });

  test("a project with ONLY co-located specs is still told they did not run", async () => {
    // The skip path returned before the warning, and it is the case where the
    // silence misleads most: `aai test` says "No test file found" while the
    // project's spec files sit right there, unrun. Measured on a real project
    // whose only spec was `tools/echo_back.test.ts` — `{"passed":true,
    // "skipped":true}` and not a word about it.
    await mkdir(path.join(tempDir, "tools"), { recursive: true });
    await writeFile(path.join(tempDir, "tools", "echo_back.test.ts"), "");
    const result = await silenced(() => executeTest(tempDir))(tempDir);

    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true } });
    expect(execaSync).not.toHaveBeenCalled();
    const [level, message] = notify.mock.calls.at(-1) as [string, string];
    expect(level).toBe("warn");
    expect(message).toContain("tools/echo_back.test.ts");
  });

  test("a project with no specs at all says nothing extra", async () => {
    // The complement: the warning names files, so with none to name it must
    // not fire — "0 other spec file(s)" is noise on an empty project.
    await silenced(() => executeTest(tempDir))(tempDir);
    expect(notify).not.toHaveBeenCalled();
  });

  test("returns passed result when vitest succeeds", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    const result = await silenced(() => executeTest(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true } });
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

describe("unrunSpecFiles", () => {
  test("names the project specs `aai test` did NOT run", async () => {
    // The shipped `retail` template carries seven of these. `aai test` there ran
    // 1 file / 67 tests, printed "Tests passed", and left 211 of the project's
    // 278 tests unrun with nothing saying so — measured on a scaffolded copy.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "store.test.ts"), "");
    await writeFile(path.join(tempDir, "seed.test.ts"), "");
    await mkdir(path.join(tempDir, "tools"), { recursive: true });
    await writeFile(path.join(tempDir, "tools", "swap.test.ts"), "");
    expect(unrunSpecFiles(tempDir, "agent.test.ts")).toEqual([
      "seed.test.ts",
      "store.test.ts",
      "tools/swap.test.ts",
    ]);
  });

  test("the file that RAN and the eval tier are both excluded", async () => {
    // Evals have their own command; excluding them by the `.eval.` INFIX rather
    // than by a filename list is what keeps this module from importing
    // `eval.ts`, which imports this one.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "");
    expect(unrunSpecFiles(tempDir, "agent.test.ts")).toEqual([]);
  });

  test("never walks into node_modules or build output", async () => {
    // A project's dependencies ship thousands of specs; naming them would make
    // the warning unreadable and wrong.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    for (const d of ["node_modules", ".aai", "dist"]) {
      await mkdir(path.join(tempDir, d), { recursive: true });
      await writeFile(path.join(tempDir, d, "vendor.test.ts"), "");
    }
    expect(unrunSpecFiles(tempDir, "agent.test.ts")).toEqual([]);
  });
});
