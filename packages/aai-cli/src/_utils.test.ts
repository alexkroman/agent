// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import {
  errorCode,
  errorDetail,
  fileExists,
  readJson,
  readTextIfPresent,
  resolveCwd,
  writeFileAtomic,
  writeJson,
} from "./_utils.ts";

describe("resolveCwd", () => {
  test("returns INIT_CWD when set", () => {
    vi.stubEnv("INIT_CWD", "/custom/path");
    expect(resolveCwd()).toBe("/custom/path");
  });

  test("falls back to process.cwd() when INIT_CWD is not set", () => {
    vi.stubEnv("INIT_CWD", undefined);
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

describe("errorDetail", () => {
  test("prefers the stack of an Error, falls back to the message", () => {
    const err = new Error("boom");
    expect(errorDetail(err)).toBe(err.stack ?? "boom");
    delete err.stack;
    expect(errorDetail(err)).toBe("boom");
  });

  test("stringifies non-errors", () => {
    expect(errorDetail("boom")).toBe("boom");
  });
});

describe("writeJson", () => {
  test("round-trips data with pretty-printing and trailing newline", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "config.json");
      await writeJson(file, { apiKey: "k", approvedServers: ["https://a.example"] });
      const raw = await fs.readFile(file, "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual({ apiKey: "k", approvedServers: ["https://a.example"] });
    });
  });

  test("creates parent directories", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "deep", "nested", "config.json");
      await writeJson(file, { a: 1 });
      expect(await readJson(file)).toEqual({ a: 1 });
    });
  });

  test("leaves no temp files behind after a successful write", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "config.json");
      await writeJson(file, { a: 1 });
      await writeJson(file, { a: 2 });
      expect(await fs.readdir(dir)).toEqual(["config.json"]);
    });
  });

  test("replaces the file atomically via rename (no partial content on overwrite)", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "config.json");
      await writeJson(file, { before: true });
      const renameSpy = vi.spyOn(fs, "rename");
      await writeJson(file, { after: true });
      // The write must go through temp-file + rename — a plain writeFile to
      // the destination can be observed (or left, on crash) half-written,
      // which reads back as `{}` and wipes the config on the next write.
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [from, to] = renameSpy.mock.calls[0] ?? [];
      expect(String(to)).toBe(file);
      expect(String(from)).not.toBe(file);
      expect(path.dirname(String(from))).toBe(dir);
      expect(await readJson(file)).toEqual({ after: true });
    });
  });

  test("cleans up the temp file when rename fails", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "config.json");
      vi.spyOn(fs, "rename").mockRejectedValue(new Error("EXDEV"));
      await expect(writeJson(file, { a: 1 })).rejects.toThrow("EXDEV");
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });
});

describe("writeFileAtomic", () => {
  test("applies the mode exactly, umask notwithstanding, and tightens an existing file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, ".env");
      await fs.writeFile(file, "OLD=1\n", { mode: 0o644 });
      await writeFileAtomic(file, "NEW=1\n", { mode: 0o600 });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(file, "utf-8")).toBe("NEW=1\n");
      expect(await fs.readdir(dir)).toEqual([".env"]);
    });
  });

  test("two concurrent writes in one process never share a temp file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "f.txt");
      const writeSpy = vi.spyOn(fs, "writeFile");
      await Promise.all([writeFileAtomic(file, "a"), writeFileAtomic(file, "b")]);
      const temps = writeSpy.mock.calls.map(([p]) => String(p));
      expect(new Set(temps).size).toBe(2);
      expect(["a", "b"]).toContain(await fs.readFile(file, "utf-8"));
      expect(await fs.readdir(dir)).toEqual(["f.txt"]);
    });
  });

  test("removes the temp file when the rename fails", async () => {
    await withTempDir(async (dir) => {
      vi.spyOn(fs, "rename").mockRejectedValue(new Error("EXDEV"));
      await expect(writeFileAtomic(path.join(dir, "f.txt"), "x", { mode: 0o600 })).rejects.toThrow(
        "EXDEV",
      );
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });
});

describe("readTextIfPresent", () => {
  test("reads a file, and answers undefined only for a missing one", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "f.txt");
      expect(await readTextIfPresent(file)).toBeUndefined();
      await fs.writeFile(file, "hi");
      expect(await readTextIfPresent(file)).toBe("hi");
      // A directory is unreadable, not absent.
      await expect(readTextIfPresent(dir)).rejects.toThrow();
    });
  });
});
