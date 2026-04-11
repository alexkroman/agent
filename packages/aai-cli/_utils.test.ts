// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { fileExists, resolveCwd } from "./_utils.ts";

describe("resolveCwd", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns INIT_CWD when set", () => {
    vi.stubEnv("INIT_CWD", "/custom/path");
    expect(resolveCwd()).toBe("/custom/path");
  });

  test("falls back to process.cwd() when INIT_CWD is not set", () => {
    delete process.env.INIT_CWD;
    expect(resolveCwd()).toBe(process.cwd());
  });
});

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "exists.txt");
      await fs.writeFile(p, "");
      expect(await fileExists(p)).toBe(true);
    });
  });

  test("returns false for missing file", async () => {
    expect(await fileExists("/tmp/does-not-exist-12345")).toBe(false);
  });

  test("returns true for existing directory", async () => {
    await withTempDir(async (dir) => {
      expect(await fileExists(dir)).toBe(true);
    });
  });
});
