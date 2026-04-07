// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { fileExists, resolveCwd } from "./_utils.ts";

describe("resolveCwd", () => {
  test("returns INIT_CWD when set", () => {
    const orig = process.env.INIT_CWD;
    process.env.INIT_CWD = "/custom/path";
    try {
      expect(resolveCwd()).toBe("/custom/path");
    } finally {
      if (orig !== undefined) {
        process.env.INIT_CWD = orig;
      } else {
        delete process.env.INIT_CWD;
      }
    }
  });

  test("falls back to process.cwd() when INIT_CWD is not set", () => {
    const orig = process.env.INIT_CWD;
    delete process.env.INIT_CWD;
    try {
      expect(resolveCwd()).toBe(process.cwd());
    } finally {
      if (orig !== undefined) {
        process.env.INIT_CWD = orig;
      }
    }
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
