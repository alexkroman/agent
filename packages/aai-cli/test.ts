// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand, step } from "./_ui.ts";

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

  execSync("npx vitest run", {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
  });

  return true;
}

/** Run agent tests. Used by `aai test`. */
export async function runTestCommand(cwd: string): Promise<void> {
  await runCommand(async ({ log }) => {
    log(step("Test", "running agent tests"));
    const ran = runVitest(cwd);
    if (!ran) {
      log("No test files found (agent.test.ts). Skipping.");
      return;
    }
    log(step("Test", "ok"));
  });
}
