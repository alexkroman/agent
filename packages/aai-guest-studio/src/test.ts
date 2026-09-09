// Copyright 2026 the AAI authors. MIT license.
/**
 * Running a studio workspace's own tests, in the guest, for `test_agent`.
 *
 * The guest toolchain carries vitest and the coding agent is told to write an
 * `agent.test.ts`, so it can get the same signal a CLI user gets from
 * `aai test` — from the tool it already reaches for. A new workspace has no
 * test file; see the "A missing vitest is not an error" note below, which
 * covers the no-test-files case too.
 *
 * Two things here are load-bearing:
 *
 * - **`--root` is not optional.** Workspaces materialize under the harness
 *   directory, which in local dev sits INSIDE this repo. Without pinning the
 *   root, vitest walks up, finds the repo's own config, and runs the entire
 *   monorepo suite inside the tenant's sandbox.
 * - **A missing vitest is not an error.** Tests are a bonus signal; a
 *   workspace whose toolchain predates vitest, or one with no test files,
 *   reports "skipped" so `test_agent` still returns its build/load result.
 */

import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { scrubDir } from "./build.ts";
import { outputWithKillNote, runCapped, workspaceChildEnv } from "./spawn.ts";

/** Wall clock for the run. The per-tool deadline (STUDIO_TOOL_TIMEOUT_MS,
 *  studio/tools.ts) is 120s and the build has already spent part of it, so
 *  leave headroom. */
const TEST_TIMEOUT_MS = 45_000;

/** Tail kept from vitest output — enough for failures, not a context dump. */
const OUTPUT_CAP = 4000;

export type TestRunResult =
  | { ran: false; reason: string }
  | { ran: true; passed: boolean; output: string };

/**
 * Test files at the workspace root (studio workspaces are flat), EVAL TIER
 * EXCLUDED.
 *
 * The exclusion is the same one `aai test` makes, by the same infix
 * (`projectSpecFiles` in `aai-cli/_vitest-runner.ts`), and it has to be made
 * here rather than left to the spawn because both halves were wrong: this
 * predicate counted `agent.eval.test.ts` as a test file, so a workspace holding
 * only an eval reported `ran` instead of "no test files".
 *
 * An eval is a LIVE-MODEL measurement that reports and does not gate — the
 * tier's own rule — and the env this run gets is scrubbed
 * (`workspaceChildEnv()`), so an eval reached from here can only ever run on a
 * scripted model: minutes of agent boots that adjudicate nothing, inside a
 * 45-second budget, and a `Tests: FAILED` on a workspace whose actual tests
 * pass. Twelve of the fifteen shipped starters copy a template and every
 * template ships an `agent.eval.test.ts`, so this was the common case and not
 * an edge one.
 */
async function testFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => /\.test\.tsx?$/.test(f) && !f.includes(".eval.test."));
}

/**
 * The workspace's own vitest binary, resolved by the same node_modules
 * walk-up everything else in the guest uses.
 *
 * `createRequire().resolve` has no async form and stays synchronous; the
 * manifest READ does not, and this runs in the same process as live voice
 * sessions, whose audio pacing is a loop on the event loop.
 */
async function resolveVitestBin(dir: string): Promise<string | null> {
  try {
    const require = createRequire(path.join(dir, "package.json"));
    const pkgPath = require.resolve("vitest/package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch {
    // No vitest resolvable above the workspace. Reported as a skip: tests
    // are extra signal and must not turn a good build into a failure.
    return null;
  }
}

/** Run the workspace's tests. Never throws — the result is prose for the agent. */
export async function runWorkspaceTests(dir: string): Promise<TestRunResult> {
  const files = await testFiles(dir);
  if (files.length === 0) return { ran: false, reason: "no test files in the workspace" };

  const bin = await resolveVitestBin(dir);
  if (!bin) return { ran: false, reason: "vitest is not available in this sandbox" };

  let code: number | null;
  let output: string;
  try {
    // `run` (never watch) and `--root` so vitest cannot escape the workspace.
    //
    // The files are passed as POSITIONAL FILTERS, which is what actually keeps
    // the eval tier out: `testFiles` decides what this run covers, and without
    // naming them vitest applies its own default include glob and finds
    // `agent.eval.test.ts` regardless of what we discovered. Same mechanism
    // `aai test` uses and same property — a filter is matched as a substring
    // against the paths vitest already found, and `agent.test.ts` is not a
    // substring of `agent.eval.test.ts`, so the two tiers stay disjoint without
    // either side listing the other's filenames.
    const result = await runCapped(process.execPath, [bin, "run", "--root", dir, ...files], {
      cwd: dir,
      // Scrubbed like every other child that executes workspace-authored code
      // (`bash`, `runNpm`, the deploy CLI): the files vitest runs here are the
      // coding agent's own `*.test.ts`. `bash` can read `/proc/<pid>/environ`
      // regardless, so this is defence in depth rather than a boundary — but it
      // was the one spawn site in the package outside the policy.
      env: { ...workspaceChildEnv(), CI: "true" },
      timeoutMs: TEST_TIMEOUT_MS,
      cap: OUTPUT_CAP,
      combineStreams: true,
    });
    code = result.exitCode;
    output = outputWithKillNote(result, TEST_TIMEOUT_MS);
  } catch (err) {
    code = -1;
    output = errorMessage(err);
  }

  return {
    ran: true,
    passed: code === 0,
    // The scratch path is an implementation detail the coding agent must not
    // see (and must not start writing absolute paths against).
    output: scrubDir(output.trim(), dir),
  };
}

/** One-line-ish summary of a test run for `test_agent`'s reply. */
export function formatTestRun(result: TestRunResult): string {
  if (!result.ran) return `Tests: skipped (${result.reason}).`;
  if (result.passed) return `Tests: passed.\n${result.output}`;
  return `Tests: FAILED — fix these or update them to match the agent.\n${result.output}`;
}
