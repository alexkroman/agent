// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { _startDevServer } from "./dev.ts";

const noop = () => {
  /* noop */
};

describe("_startDevServer", () => {
  test("throws when no agent found", async () => {
    await withTempDir(async (dir) => {
      await expect(_startDevServer(dir, 3000, noop)).rejects.toThrow("No agent found");
    });
  });

  test("error message suggests aai init", async () => {
    await withTempDir(async (dir) => {
      await expect(_startDevServer(dir, 3000, noop)).rejects.toThrow("aai init");
    });
  });

  test("check mode throws when no agent found", async () => {
    await withTempDir(async (dir) => {
      await expect(_startDevServer(dir, 3000, noop, { check: true })).rejects.toThrow(
        "No agent found",
      );
    });
  });

  test("check mode with agent.ts fails during bundle (no valid project)", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      await expect(_startDevServer(dir, 3000, noop, { check: true })).rejects.toThrow();
    });
  });
});
