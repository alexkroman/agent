// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { errorCode, fileExists, readJson, resolveCwd } from "./_utils.ts";

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

describe("readJson", () => {
  test("returns null only for a missing file (ENOENT)", async () => {
    await withTempDir(async (dir) => {
      expect(await readJson(path.join(dir, "missing.json"))).toBeNull();
    });
  });

  test("parses an existing JSON file", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "ok.json");
      await fs.writeFile(p, '{"a":1}');
      expect(await readJson(p)).toEqual({ a: 1 });
    });
  });

  test("throws (not null) for a corrupt JSON file, naming the file", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "corrupt.json");
      await fs.writeFile(p, "{ not json");
      await expect(readJson(p)).rejects.toThrow(`Invalid JSON in ${p}`);
    });
  });

  test("rethrows non-ENOENT filesystem errors", async () => {
    await withTempDir(async (dir) => {
      // Reading a directory as a file fails with EISDIR, which must propagate.
      await expect(readJson(dir)).rejects.toThrow();
    });
  });
});

describe("errorCode", () => {
  test("returns the code of an errno-style error", () => {
    const err = new Error("boom") as NodeJS.ErrnoException;
    err.code = "ENOSPC";
    expect(errorCode(err)).toBe("ENOSPC");
  });

  test("returns undefined for plain errors and non-errors", () => {
    expect(errorCode(new Error("boom"))).toBeUndefined();
    expect(errorCode("boom")).toBeUndefined();
  });
});
