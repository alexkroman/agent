// Copyright 2025 the AAI authors. MIT license.
// `aai test` — run agent tests via vitest.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

type TestData = { passed: boolean; skipped?: boolean };

/** Returns false if no test file exists; throws on test failure. */
export function runVitest(cwd: string): boolean {
  const testFile = ["agent.test.ts", "agent.test.js"].find((f) => existsSync(path.join(cwd, f)));
  if (!testFile) return false;

  execFileSync("npx", ["vitest", "run", "--root", ".", testFile], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
  });
  return true;
}

export async function executeTest(cwd: string): Promise<CommandResult<TestData>> {
  log.step("Running agent tests");
  try {
    if (!runVitest(cwd)) {
      log.info("No test file found. Create agent.test.ts to add tests.");
      return ok({ passed: true, skipped: true });
    }
    log.success("Tests passed");
    return ok({ passed: true });
  } catch {
    return fail("test_failed", "Tests failed");
  }
}
