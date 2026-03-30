// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { consola } from "./_ui.ts";

/**
 * Run vitest in the given project directory.
 *
 * Returns `true` if tests passed, `false` if no test files exist.
 * Throws on test failure.
 */
export function runVitest(cwd: string): boolean {
  // Check for any test files
  const hasTests =
    existsSync(path.join(cwd, "agent.test.ts")) || existsSync(path.join(cwd, "agent.test.js"));

  if (!hasTests) return false;

  const testFile = existsSync(path.join(cwd, "agent.test.ts")) ? "agent.test.ts" : "agent.test.js";

  execSync(`npx vitest run --root . ${testFile}`, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
  });

  return true;
}

/** Run agent tests. Used by `aai test`. */
export async function runTestCommand(cwd: string): Promise<void> {
  consola.start("Running agent tests");
  const ran = runVitest(cwd);
  if (!ran) {
    consola.info("No test file found. Create agent.test.ts to add tests.");
    return;
  }
  consola.success("Tests passed");
}
