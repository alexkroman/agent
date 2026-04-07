// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "./_ui.ts";

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

/** Run agent tests. Used by `aai test`. */
export async function runTestCommand(cwd: string): Promise<void> {
  log.step("Running agent tests");
  const ran = runVitest(cwd);
  if (!ran) {
    log.info("No test file found. Create agent.test.ts to add tests.");
    return;
  }
  log.success("Tests passed");
}
