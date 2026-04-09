// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

type TestData = { passed: boolean; skipped?: boolean };

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

  execFileSync("npx", ["vitest", "run", "--root", ".", testFile], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
  });

  return true;
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
  } catch {
    return fail("test_failed", "Tests failed");
  }
}

/** Run agent tests. Used by `aai test`. */
export async function runTestCommand(cwd: string): Promise<void> {
  const result = await executeTest(cwd);
  if (!result.ok) throw new Error(result.error);
}
