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

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { scrubDir } from "./studio-build.ts";
import { runCapped } from "./studio-spawn.ts";

/** Wall clock for the run. The per-tool deadline (STUDIO_TOOL_TIMEOUT_MS,
 *  studio-tools.ts) is 120s and the build has already spent part of it, so
 *  leave headroom. */
const TEST_TIMEOUT_MS = 45_000;

/** Tail kept from vitest output — enough for failures, not a context dump. */
const OUTPUT_CAP = 4000;

export type TestRunResult =
  | { ran: false; reason: string }
  | { ran: true; passed: boolean; output: string };

/** Test files at the workspace root (studio workspaces are flat). */
async function testFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => /\.test\.tsx?$/.test(f));
}

/**
 * The workspace's own vitest binary, resolved by the same node_modules
 * walk-up everything else in the guest uses.
 */
function resolveVitestBin(dir: string): string | null {
  try {
    const require = createRequire(path.join(dir, "package.json"));
    const pkgPath = require.resolve("vitest/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
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

  const bin = resolveVitestBin(dir);
  if (!bin) return { ran: false, reason: "vitest is not available in this sandbox" };

  let code: number | null;
  let output: string;
  try {
    // `run` (never watch) and `--root` so vitest cannot escape the workspace.
    const result = await runCapped(process.execPath, [bin, "run", "--root", dir], {
      cwd: dir,
      env: { ...process.env, CI: "true" },
      timeoutMs: TEST_TIMEOUT_MS,
      cap: OUTPUT_CAP,
      combineStreams: true,
    });
    code = result.exitCode;
    output = result.signal
      ? `${result.stdout}\n[killed by ${result.signal} after ${TEST_TIMEOUT_MS}ms]`
      : result.stdout;
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
