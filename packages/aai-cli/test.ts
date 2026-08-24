// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { execaSync } from "execa";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { binFromPackageJson, errorCode, errorMessage } from "./_utils.ts";

type TestData = { passed: boolean; skipped?: boolean };

/**
 * Resolve the agent project's own vitest binary so tests run without the
 * npx resolution overhead (and its potential network fetch of vitest).
 *
 * Resolves `vitest/package.json` from the agent directory, derives the bin
 * script, and runs it with the current Node executable. Falls back to
 * `npx vitest` only when no local install is resolvable.
 */
export function resolveVitestCommand(
  cwd: string,
  // Injectable for tests: vitest's own worker sets NODE_PATH, which would
  // make the real resolver always succeed under `pnpm test`.
  resolve: (id: string) => string = createRequire(path.join(cwd, "package.json")).resolve,
): { cmd: string; args: string[] } {
  try {
    const bin = binFromPackageJson(resolve("vitest/package.json"), "vitest");
    if (bin) {
      // Run the bin JS with the current Node executable — avoids relying on
      // node_modules/.bin shims (shell wrappers, platform differences).
      return { cmd: process.execPath, args: [bin] };
    }
  } catch {
    /* not installed locally — fall through to npx */
  }
  return { cmd: "npx", args: ["vitest"] };
}

/** The files `aai test` runs, in preference order. */
export const TEST_FILES = ["agent.test.ts", "agent.test.js"] as const;

/** Which files to run, and how — see {@link runVitest}. */
export type VitestRunOptions = {
  /** File names to look for in the project root, in preference order. */
  readonly candidates: readonly string[];
  /** Extra vitest CLI arguments, inserted before the file name. */
  readonly extraArgs?: readonly string[];
  /**
   * Variables to add to the child's environment. Absent leaves the child with
   * the parent's env untouched, which is what `aai test` wants; `aai eval`
   * passes the project's `.env` so an eval can reach the provider key the same
   * way a session under `aai dev` does.
   */
  readonly env?: Record<string, string>;
};

/**
 * Run vitest over one of `candidates` in the given project directory.
 *
 * Returns `true` if it ran, `false` if none of the candidate files exists.
 * Throws on failure.
 *
 * A vitest FILTER, not an include glob: the argument is matched as a substring
 * against the paths vitest's own include globs already found, which is why the
 * candidates are named `*.test.ts` — `agent.test.ts` cannot match
 * `agent.eval.test.ts` and vice versa, so the two commands stay disjoint
 * without either one having to exclude the other's file.
 */
export function runVitest(
  cwd: string,
  opts: VitestRunOptions = { candidates: TEST_FILES },
): boolean {
  const testFile = opts.candidates.find((name) => existsSync(path.join(cwd, name)));
  if (!testFile) return false;

  const { cmd, args } = resolveVitestCommand(cwd);
  // No NODE_OPTIONS override: this used to force `--experimental-strip-types`,
  // which is redundant on every Node this CLI supports (`engines.node >=24`) —
  // type stripping has been on by default since 23.6, and in Node 26 the flag
  // survives only as an alias for `--strip-types`. Setting NODE_OPTIONS is not
  // free either: it propagates to every vitest worker, so a value that ever
  // stops being accepted would fail the whole run rather than degrade.
  execaSync(cmd, [...args, "run", "--root", ".", ...(opts.extraArgs ?? []), testFile], {
    cwd,
    stdio: "inherit",
    // `omitUndefined`, not a conditional spread: `guard-invariants` rule 2.
    ...omitUndefined({ env: opts.env ? { ...process.env, ...opts.env } : undefined }),
  });

  return true;
}

/**
 * Classify a {@link runVitest} failure. execaSync throws an ENOENT-coded
 * error when the binary itself couldn't be spawned (infrastructure problem)
 * and an exit-code error when vitest ran and the tests failed.
 */
export function classifyVitestError(
  err: unknown,
  /** What failed, for the message — `aai eval` runs the same runner. */
  label = "Tests",
): {
  code: "spawn_failed" | "test_failed";
  message: string;
} {
  if (errorCode(err) === "ENOENT") {
    return {
      code: "spawn_failed",
      // execFileSync's ENOENT message names the missing binary ("spawnSync npx ENOENT").
      message: `Could not launch the test runner: ${errorMessage(err)} — is the binary on your PATH?`,
    };
  }
  return { code: "test_failed", message: `${label} failed: ${errorMessage(err)}` };
}

/** Execute agent tests and return structured result. */
export async function executeTest(cwd: string): Promise<CommandResult<TestData>> {
  log.step("Running agent tests");
  try {
    const ran = runVitest(cwd);
    if (!ran) {
      log.info("No test file found. Create agent.test.ts to add tests.");
      return ok({ passed: true, skipped: true });
    }
    log.success("Tests passed");
    return ok({ passed: true });
  } catch (err: unknown) {
    const { code, message } = classifyVitestError(err);
    return fail(code, message);
  }
}
