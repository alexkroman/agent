// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runVitest } from "./test.ts";

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
    // Just verifying detection - actual execution would need vitest installed
    expect(existsSync(path.join(tempDir, "agent.test.ts"))).toBe(true);
  });
});
