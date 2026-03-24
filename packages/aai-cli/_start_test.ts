// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test_utils.ts";
import { _startProductionServer, runStartCommand } from "./start.tsx";

describe("_startProductionServer", () => {
  test("throws when build directory is missing", async () => {
    await withTempDir(async (dir) => {
      await expect(_startProductionServer(dir, 3000, () => {})).rejects.toThrow();
    });
  });
});

describe("runStartCommand", () => {
  test("throws when no build found", async () => {
    await withTempDir(async (dir) => {
      await expect(runStartCommand({ cwd: dir, port: "3000" })).rejects.toThrow("No build found");
    });
  });

  test("error message suggests aai build", async () => {
    await withTempDir(async (dir) => {
      await expect(runStartCommand({ cwd: dir, port: "3000" })).rejects.toThrow(
        "run `aai build` first",
      );
    });
  });

  test("does not throw missing-build when worker.js exists", async () => {
    await withTempDir(async (dir) => {
      const buildDir = path.join(dir, ".aai", "build");
      await fs.mkdir(buildDir, { recursive: true });
      await fs.writeFile(path.join(buildDir, "worker.js"), "// worker");
      // Will fail later (no agent.ts), but should get past the build check
      await expect(runStartCommand({ cwd: dir, port: "3000" })).rejects.not.toThrow(
        "No build found",
      );
    });
  });
});
