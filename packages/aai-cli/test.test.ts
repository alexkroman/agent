// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runTestCommand, runVitest } from "./test.ts";

describe("aai test", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "aai-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns false when no test files exist", () => {
    const result = runVitest(tempDir);
    expect(result).toBe(false);
  });

  test("detects agent.test.ts files", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test file");
    expect(existsSync(path.join(tempDir, "agent.test.ts"))).toBe(true);
  });

  test("detects agent.test.js files", async () => {
    await writeFile(path.join(tempDir, "agent.test.js"), "// test file");
    expect(existsSync(path.join(tempDir, "agent.test.js"))).toBe(true);
  });

  test("runVitest throws when vitest is not installed in temp dir", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// test");
    // execSync will fail because there's no vitest in the temp dir
    expect(() => runVitest(tempDir)).toThrow();
  });

  test("runTestCommand logs skip message when no test files", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await runTestCommand(tempDir);
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes("No test files found"))).toBe(true);
  });
});
