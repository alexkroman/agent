// Copyright 2026 the AAI authors. MIT license.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import {
  projectSpecFiles,
  resolveVitestCommand,
  runVitest,
  unrunSpecFiles,
} from "./_vitest-runner.ts";
import { invocation, test } from "./_vitest-runner-test-utils.ts";
import { TEST_FILES } from "./test.ts";

/**
 * A real caller's candidate list.
 *
 * `runVitest` takes `candidates` with no default precisely so it names no tier,
 * so these specs supply one the way a command does — `aai test`'s, since the
 * `.ts`-then-`.js` preference order is one of the things under test here.
 */
const candidates = TEST_FILES;

describe("runVitest", () => {
  test("returns false when no test files exist", ({ tmpDir, deps }) => {
    const result = runVitest(tmpDir, { ...deps, candidates });
    expect(result).toBe(false);
  });

  test("detects agent.test.js when there is no agent.test.ts", async ({ tmpDir, deps, exec }) => {
    // This used to assert `existsSync` on the file it had itself just written,
    // so it passed with `test.ts` deleted. The `.js` arm is the half of
    // `runVitest`'s detection the `.ts` test below does not reach.
    await writeFile(path.join(tmpDir, "agent.test.js"), "// test file");
    // The NAMES it ran, not a boolean — the caller reports them and
    // `unrunSpecFiles` reports the complement.
    expect(runVitest(tmpDir, { ...deps, candidates })).toEqual(["agent.test.js"]);
    expect(invocation(exec).args.at(-1)).toBe("agent.test.js");
  });

  test("runs vitest against agent.test.ts without overriding NODE_OPTIONS", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");
    expect(runVitest(tmpDir, { ...deps, candidates })).toEqual(["agent.test.ts"]);
    const { args, opts } = invocation(exec);
    // Resolution mode (local bin vs npx) varies by environment; the vitest
    // CLI arguments and env are the same either way.
    expect(args.slice(-4)).toEqual(["run", "--root", ".", "agent.test.ts"]);
    expect(opts.cwd).toBe(tmpDir);
    // Type stripping is default-on for every supported Node, so the child
    // inherits the parent env untouched — no NODE_OPTIONS to propagate into
    // vitest's workers.
    expect(opts.env).toBeUndefined();
  });

  test("runs the project-local vitest bin directly when installed", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    // Fake a local vitest install in the agent project.
    const vitestDir = path.join(tmpDir, "node_modules", "vitest");
    await mkdir(vitestDir, { recursive: true });
    await writeFile(
      path.join(vitestDir, "package.json"),
      JSON.stringify({ name: "vitest", version: "0.0.0", bin: { vitest: "vitest.mjs" } }),
    );
    await writeFile(path.join(vitestDir, "vitest.mjs"), "// fake bin");
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");

    expect(runVitest(tmpDir, { ...deps, candidates })).toEqual(["agent.test.ts"]);
    const { cmd, args } = invocation(exec);
    // No npx: the local bin JS runs with the current Node executable.
    expect(cmd).toBe(process.execPath);
    expect(args[0]?.endsWith(path.join("node_modules", "vitest", "vitest.mjs"))).toBe(true);
    expect(args.slice(1)).toEqual(["run", "--root", ".", "agent.test.ts"]);
  });

  test("resolveVitestCommand falls back to npx when vitest is not resolvable", ({ tmpDir }) => {
    const failingResolve = () => {
      throw new Error("Cannot find module 'vitest/package.json'");
    };
    expect(resolveVitestCommand(tmpDir, failingResolve)).toEqual({
      cmd: "npx",
      args: ["vitest"],
    });
  });

  test("resolveVitestCommand runs the resolved bin with the current node", async ({ tmpDir }) => {
    const vitestDir = path.join(tmpDir, "node_modules", "vitest");
    await mkdir(vitestDir, { recursive: true });
    await writeFile(
      path.join(vitestDir, "package.json"),
      JSON.stringify({ name: "vitest", bin: { vitest: "dist/cli.mjs" } }),
    );
    const resolve = () => path.join(vitestDir, "package.json");
    expect(resolveVitestCommand(tmpDir, resolve)).toEqual({
      cmd: process.execPath,
      args: [path.join(vitestDir, "dist", "cli.mjs")],
    });
  });

  test("falls back to agent.test.js when no .ts test exists", async ({ tmpDir, deps, exec }) => {
    await writeFile(path.join(tmpDir, "agent.test.js"), "// test file");
    expect(runVitest(tmpDir, { ...deps, candidates })).toEqual(["agent.test.js"]);
    expect(invocation(exec).args).toContain("agent.test.js");
  });

  test("the extra vitest arguments a caller passes land before the file names", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    // `aai eval`'s `--testTimeout` is the caller this exists for: vitest's 5s
    // default is shorter than one live model turn, and an argument placed after
    // the positional filters would be read as another filter.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");
    runVitest(tmpDir, { ...deps, candidates, extraArgs: ["--testTimeout", "300000"] });
    expect(invocation(exec).args.slice(-5)).toEqual([
      "--root",
      ".",
      "--testTimeout",
      "300000",
      "agent.test.ts",
    ]);
  });

  test("a caller's env additions are merged over the parent env, not replacing it", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    // `aai eval` hands the project's `.env` to the child so a case can reach the
    // provider key; losing the parent env with it would take PATH out from under
    // the runner.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "// test file");
    runVitest(tmpDir, { ...deps, candidates, env: { AAI_SPEC_ONLY: "1" } });
    const { opts } = invocation(exec);
    expect(opts.env?.AAI_SPEC_ONLY).toBe("1");
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });
});

describe("runVitest announces what it did not run", () => {
  test("a caller that reports nothing of its own gets the notice by default", async ({
    tmpDir,
    deps,
    notify,
  }) => {
    // `aai build`'s pre-build gate was that caller: it called `runVitest(cwd)`
    // and printed "Build complete", so a build gated on one file out of eight
    // said so nowhere. Both gates pass `all` now — this is `aai test --only`'s
    // notice — but the DEFAULT is what closed it without a caller having to know.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "store.test.ts"), "");
    runVitest(tmpDir, { ...deps, candidates });
    const [level, message] = notify.mock.calls.at(-1) ?? [];
    expect(level).toBe("warn");
    expect(message).toContain("store.test.ts");
    // The remedy, not just the finding — and it is a bare `aai test` now,
    // because running every non-eval spec is what that does.
    expect(message).toContain("`aai test`");
    expect(message).not.toContain("--all");
  });

  test("a complete run says nothing", async ({ tmpDir, deps, notify }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    runVitest(tmpDir, { ...deps, candidates });
    expect(notify).not.toHaveBeenCalled();
  });

  test("announceUnrun: false silences it for a caller that reports the set itself", async ({
    tmpDir,
    deps,
    notify,
  }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "store.test.ts"), "");
    runVitest(tmpDir, { ...deps, candidates: ["agent.test.ts"], announceUnrun: false });
    expect(notify).not.toHaveBeenCalled();
  });

  test("`all` runs every non-eval spec, and the eval tier stays disjoint", async ({
    tmpDir,
    deps,
    exec,
  }) => {
    // Still a FILTER list rather than an include glob, which is what keeps a
    // widened run from reaching `agent.eval.test.ts`.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "");
    await mkdir(path.join(tmpDir, "tools"), { recursive: true });
    await writeFile(path.join(tmpDir, "tools", "swap.test.ts"), "");
    expect(runVitest(tmpDir, { ...deps, candidates: ["agent.test.ts"], all: true })).toEqual([
      "agent.test.ts",
      "tools/swap.test.ts",
    ]);
    expect(invocation(exec).args.slice(-2)).toEqual(["agent.test.ts", "tools/swap.test.ts"]);
  });

  test("`all` with nothing to run does not spawn vitest", ({ tmpDir, deps, exec }) => {
    expect(runVitest(tmpDir, { ...deps, candidates: ["agent.test.ts"], all: true })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("unrunSpecFiles", () => {
  test("names the project specs `aai test` did NOT run", async ({ tmpDir }) => {
    // The shipped `retail-orders-agent` template carries seven of these. `aai test` there ran
    // 1 file / 67 tests, printed "Tests passed", and left 211 of the project's
    // 278 tests unrun with nothing saying so — measured on a scaffolded copy.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "store.test.ts"), "");
    await writeFile(path.join(tmpDir, "seed.test.ts"), "");
    await mkdir(path.join(tmpDir, "tools"), { recursive: true });
    await writeFile(path.join(tmpDir, "tools", "swap.test.ts"), "");
    expect(unrunSpecFiles(tmpDir, "agent.test.ts")).toEqual([
      "seed.test.ts",
      "store.test.ts",
      "tools/swap.test.ts",
    ]);
  });

  test("a widened run covers the whole set, so nothing is unrun", async ({ tmpDir }) => {
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "store.test.ts"), "");
    expect(unrunSpecFiles(tmpDir, ["agent.test.ts", "store.test.ts"])).toEqual([]);
  });

  test("the file that RAN and the eval tier are both excluded", async ({ tmpDir }) => {
    // Evals have their own command; excluding them by the `.eval.` INFIX rather
    // than by a filename list is what keeps this module from importing
    // `eval.ts`, which imports this one.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    await writeFile(path.join(tmpDir, "agent.eval.test.ts"), "");
    expect(unrunSpecFiles(tmpDir, "agent.test.ts")).toEqual([]);
    expect(projectSpecFiles(tmpDir)).toEqual(["agent.test.ts"]);
  });

  test("never walks into node_modules or build output", async ({ tmpDir }) => {
    // A project's dependencies ship thousands of specs; naming them would make
    // the warning unreadable and wrong.
    await writeFile(path.join(tmpDir, "agent.test.ts"), "");
    for (const d of ["node_modules", ".aai", "dist"]) {
      await mkdir(path.join(tmpDir, d), { recursive: true });
      await writeFile(path.join(tmpDir, d, "vendor.test.ts"), "");
    }
    expect(unrunSpecFiles(tmpDir, "agent.test.ts")).toEqual([]);
  });
});
