// Copyright 2026 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { StudioBuildError } from "./studio-errors.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

const BUILD_ROOT = path.resolve(import.meta.dirname, ".studio-build");

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

describe("withWorkspaceDir", () => {
  test("sweeps stale scratch dirs from a previous process on first use", async () => {
    // Must run before any other withWorkspaceDir call in this file: the
    // sweep is once-per-process (per module instance) by design.
    const stale = path.join(BUILD_ROOT, "stale-from-a-crash");
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, "leftover.ts"), "x", "utf-8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, twoHoursAgo, twoHoursAgo);
    // Fresh entries belong to a live process (parallel workers share this
    // root) and must survive the sweep.
    const recent = path.join(BUILD_ROOT, "recent-other-process");
    await fs.mkdir(recent, { recursive: true });
    try {
      await withWorkspaceDir({ "agent.ts": "export {};" }, async () => undefined);
      expect(await exists(stale)).toBe(false);
      expect(await exists(recent)).toBe(true);
    } finally {
      await fs.rm(recent, { recursive: true, force: true });
    }
  });

  test("materializes files and cleans up after fn resolves", async () => {
    let seenDir = "";
    const result = await withWorkspaceDir({ "a/b.ts": "content" }, async (dir) => {
      seenDir = dir;
      return await fs.readFile(path.join(dir, "a", "b.ts"), "utf-8");
    });
    expect(result).toBe("content");
    expect(await exists(seenDir)).toBe(false);
  });

  test("cleans up the scratch dir when fn throws", async () => {
    let seenDir = "";
    await expect(
      withWorkspaceDir({ "agent.ts": "x" }, async (dir) => {
        seenDir = dir;
        throw new Error("build exploded");
      }),
    ).rejects.toThrow("build exploded");
    expect(seenDir).not.toBe("");
    expect(await exists(seenDir)).toBe(false);
  });

  test.each([["../evil.ts"], ["a/../../x.ts"], ["/abs.ts"]])(
    "rejects the traversal path %j and writes nothing outside the scratch dir",
    async (bad) => {
      await expect(withWorkspaceDir({ [bad]: "x" }, async () => undefined)).rejects.toThrow(
        StudioBuildError,
      );
      // Nothing may escape BUILD_ROOT: the climb targets its parent (the
      // server package directory).
      const parent = path.dirname(BUILD_ROOT);
      expect(await exists(path.join(parent, "evil.ts"))).toBe(false);
      expect(await exists(path.join(parent, "x.ts"))).toBe(false);
      expect(await exists("/abs.ts")).toBe(false);
    },
  );
});
