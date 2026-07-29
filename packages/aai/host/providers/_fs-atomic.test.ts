// Copyright 2025 the AAI authors. MIT license.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withAtomicFsWrites } from "./_fs-atomic.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aai_fs_atomic_"));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Load the real unstorage fs driver, wrapped. */
async function makeDriver(base: string) {
  const { default: fsDriver } = await import("unstorage/drivers/fs");
  return withAtomicFsWrites(fsDriver({ base }), base);
}

describe("withAtomicFsWrites", () => {
  it("round-trips values through the wrapped driver's reads", async () => {
    await withTempDir(async (dir) => {
      const driver = await makeDriver(dir);
      await driver.setItem?.("ns:key", JSON.stringify({ n: 1 }), {});
      // Reads go through the stock driver — the same file must be found.
      expect(await driver.getItem("ns:key")).toBe(JSON.stringify({ n: 1 }));
      expect(await driver.hasItem("ns:key", {})).toBe(true);
    });
  });

  it("writes via temp file + rename, leaving no temp files behind", async () => {
    await withTempDir(async (dir) => {
      const driver = await makeDriver(dir);
      const renameSpy = vi.spyOn(fsp, "rename");
      await driver.setItem?.("a:b:c", "value", {});
      await driver.setItem?.("a:b:c", "value2", {});
      expect(renameSpy).toHaveBeenCalledTimes(2);
      const [from, to] = renameSpy.mock.calls[0] ?? [];
      expect(String(to)).toBe(path.join(dir, "a", "b", "c"));
      expect(String(from)).not.toBe(String(to));
      renameSpy.mockRestore();
      expect(await fsp.readdir(path.join(dir, "a", "b"))).toEqual(["c"]);
      expect(await driver.getItem("a:b:c")).toBe("value2");
    });
  });

  it("cleans up the temp file when the rename fails", async () => {
    await withTempDir(async (dir) => {
      const driver = await makeDriver(dir);
      const renameSpy = vi.spyOn(fsp, "rename").mockRejectedValue(new Error("EXDEV"));
      await expect(driver.setItem?.("k", "v", {})).rejects.toThrow("EXDEV");
      renameSpy.mockRestore();
      expect(await fsp.readdir(dir)).toEqual([]);
    });
  });

  it("rejects keys with .. segments (same guard as the stock driver)", async () => {
    await withTempDir(async (dir) => {
      const driver = await makeDriver(dir);
      await expect(async () => driver.setItem?.("..:escape", "v", {})).rejects.toThrow(
        /invalid key/,
      );
      await expect(async () => driver.setItem?.("escape:..", "v", {})).rejects.toThrow(
        /invalid key/,
      );
    });
  });

  it("rejects a `../`-with-slashes key that escapes the KV root (write, read, delete)", async () => {
    await withTempDir(async (dir) => {
      // A tenant KV directory sits under the root; the escape target is a
      // sibling the guard must never let a key reach.
      const kvRoot = path.join(dir, "kv");
      await fsp.mkdir(kvRoot, { recursive: true });
      const { default: fsDriver } = await import("unstorage/drivers/fs");
      const driver = withAtomicFsWrites(fsDriver({ base: kvRoot }), kvRoot);

      // No colons, so the stock `/\.\.:|\.\.$/` guard missed it: `../pwned`
      // resolves to a sibling of the KV root.
      const escapeKey = "../pwned";
      await expect(async () => driver.setItem?.(escapeKey, "owned", {})).rejects.toThrow(
        /escapes the KV root/,
      );
      await expect(async () => driver.getItem?.(escapeKey)).rejects.toThrow(/escapes the KV root/);
      await expect(async () => driver.removeItem?.(escapeKey, {})).rejects.toThrow(
        /escapes the KV root/,
      );
      // Nothing was written outside the KV root.
      expect(await fsp.readdir(dir)).toEqual(["kv"]);
    });
  });

  it("rejects an over-long key", async () => {
    await withTempDir(async (dir) => {
      const driver = await makeDriver(dir);
      await expect(async () => driver.setItem?.("x".repeat(1025), "v", {})).rejects.toThrow(
        /invalid key length/,
      );
    });
  });

  it("delegates removal and key listing to the wrapped driver", async () => {
    await withTempDir(async (dir) => {
      const driver = await makeDriver(dir);
      await driver.setItem?.("x:one", "1", {});
      await driver.setItem?.("x:two", "2", {});
      const keys = await driver.getKeys("", {});
      expect(keys.sort()).toEqual(["x/one", "x/two"]);
      await driver.removeItem?.("x:one", {});
      expect(await driver.hasItem("x:one", {})).toBe(false);
    });
  });
});
