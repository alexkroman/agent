// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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

/**
 * Run vitest in the given project directory.
 *
 * Returns `true` if tests passed, `false` if no test files exist.
 * Throws on test failure.
 */
export function runVitest(cwd: string): boolean {
  let testFile: string | null = null;
  if (existsSync(path.join(cwd, "agent.test.ts"))) testFile = "agent.test.ts";
  else if (existsSync(path.join(cwd, "agent.test.js"))) testFile = "agent.test.js";

  if (!testFile) return false;

  const { cmd, args } = resolveVitestCommand(cwd);
  // execa extends process.env by default, so only the override is passed.
  execaSync(cmd, [...args, "run", "--root", ".", testFile], {
    cwd,
    stdio: "inherit",
    env: { NODE_OPTIONS: "--experimental-strip-types" },
  });

  return true;
}

/**
 * Classify a {@link runVitest} failure. execaSync throws an ENOENT-coded
 * error when the binary itself couldn't be spawned (infrastructure problem)
 * and an exit-code error when vitest ran and the tests failed.
 */
export function classifyVitestError(err: unknown): {
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
  return { code: "test_failed", message: `Tests failed: ${errorMessage(err)}` };
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
