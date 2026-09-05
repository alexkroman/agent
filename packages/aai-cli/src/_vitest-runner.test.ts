// Copyright 2026 the AAI authors. MIT license.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  projectSpecFiles,
  resolveVitestCommand,
  runVitest,
  unrunSpecFiles,
} from "./_vitest-runner.ts";
import { TEST_FILES } from "./test.ts";

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
  tempDir = await mkdtemp(path.join(tmpdir(), "aai-vitest-runner-"));
  // Both are factory `vi.fn()`s rather than spies, so `restoreMocks` does not
  // reach them and their call history would otherwise be cumulative.
  execaSync.mockReset();
  notify.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** The vitest CLI arguments of the run under test. */
function vitestArgs(): string[] {
  const [, args] = execaSync.mock.calls[0] as [string, string[]];
  return args;
}

/**
 * A real caller's candidate list.
 *
 * `runVitest` takes `candidates` with no default precisely so it names no tier,
 * so these specs supply one the way a command does — `aai test`'s, since the
 * `.ts`-then-`.js` preference order is one of the things under test here.
 */
const candidates = TEST_FILES;

describe("runVitest", () => {
  test("returns false when no test files exist", () => {
    const result = runVitest(tempDir, { candidates });
    expect(result).toBe(false);
  });

  test("detects agent.test.js when there is no agent.test.ts", async () => {
    // This used to assert `existsSync` on the file it had itself just written,
    // so it passed with `test.ts` deleted. The `.js` arm is the half of
    // `runVitest`'s detection the `.ts` test below does not reach.
    await writeFile(path.join(tempDir, "agent.test.js"), "// test file");
    // The NAMES it ran, not a boolean — the caller reports them and
    // `unrunSpecFiles` reports the complement.
    expect(runVitest(tempDir, { candidates })).toEqual(["agent.test.js"]);
    expect(vitestArgs().at(-1)).toBe("agent.test.js");
  });

  test("runs vitest against agent.test.ts without overriding NODE_OPTIONS", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    expect(runVitest(tempDir, { candidates })).toEqual(["agent.test.ts"]);
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

    expect(runVitest(tempDir, { candidates })).toEqual(["agent.test.ts"]);
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
    expect(runVitest(tempDir, { candidates })).toEqual(["agent.test.js"]);
    expect(vitestArgs()).toContain("agent.test.js");
  });

  test("the extra vitest arguments a caller passes land before the file names", async () => {
    // `aai eval`'s `--testTimeout` is the caller this exists for: vitest's 5s
    // default is shorter than one live model turn, and an argument placed after
    // the positional filters would be read as another filter.
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    runVitest(tempDir, { candidates, extraArgs: ["--testTimeout", "300000"] });
    expect(vitestArgs().slice(-5)).toEqual([
      "--root",
      ".",
      "--testTimeout",
      "300000",
      "agent.test.ts",
    ]);
  });

  test("a caller's env additions are merged over the parent env, not replacing it", async () => {
    // `aai eval` hands the project's `.env` to the child so a case can reach the
    // provider key; losing the parent env with it would take PATH out from under
    // the runner.
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    runVitest(tempDir, { candidates, env: { AAI_SPEC_ONLY: "1" } });
    const [, , opts] = execaSync.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    expect(opts.env?.AAI_SPEC_ONLY).toBe("1");
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });
});

describe("runVitest announces what it did not run", () => {
  test("a caller that reports nothing of its own gets the notice by default", async () => {
    // `aai build`'s pre-build gate is that caller: it calls `runVitest(cwd)` and
    // prints "Build complete", so a build gated on one file out of eight said so
    // nowhere. The default is what closes it without the gate having to know.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "store.test.ts"), "");
    runVitest(tempDir, { candidates });
    const [level, message] = notify.mock.calls.at(-1) as [string, string];
    expect(level).toBe("warn");
    expect(message).toContain("store.test.ts");
    // The remedy, not just the finding.
    expect(message).toContain("aai test --all");
  });

  test("a complete run says nothing", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    runVitest(tempDir, { candidates });
    expect(notify).not.toHaveBeenCalled();
  });

  test("announceUnrun: false silences it for a caller that reports the set itself", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "store.test.ts"), "");
    runVitest(tempDir, { candidates: ["agent.test.ts"], announceUnrun: false });
    expect(notify).not.toHaveBeenCalled();
  });

  test("`all` runs every non-eval spec, and the eval tier stays disjoint", async () => {
    // Still a FILTER list rather than an include glob, which is what keeps
    // `aai test --all` from reaching `agent.eval.test.ts`.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "");
    await mkdir(path.join(tempDir, "tools"), { recursive: true });
    await writeFile(path.join(tempDir, "tools", "swap.test.ts"), "");
    expect(runVitest(tempDir, { candidates: ["agent.test.ts"], all: true })).toEqual([
      "agent.test.ts",
      "tools/swap.test.ts",
    ]);
    expect(vitestArgs().slice(-2)).toEqual(["agent.test.ts", "tools/swap.test.ts"]);
  });

  test("`all` with nothing to run does not spawn vitest", () => {
    expect(runVitest(tempDir, { candidates: ["agent.test.ts"], all: true })).toBe(false);
    expect(execaSync).not.toHaveBeenCalled();
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

  test("a widened run covers the whole set, so nothing is unrun", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "store.test.ts"), "");
    expect(unrunSpecFiles(tempDir, ["agent.test.ts", "store.test.ts"])).toEqual([]);
  });

  test("the file that RAN and the eval tier are both excluded", async () => {
    // Evals have their own command; excluding them by the `.eval.` INFIX rather
    // than by a filename list is what keeps this module from importing
    // `eval.ts`, which imports this one.
    await writeFile(path.join(tempDir, "agent.test.ts"), "");
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "");
    expect(unrunSpecFiles(tempDir, "agent.test.ts")).toEqual([]);
    expect(projectSpecFiles(tempDir)).toEqual(["agent.test.ts"]);
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
