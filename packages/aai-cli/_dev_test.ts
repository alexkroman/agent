// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test_utils.ts";
import { _startDevServer } from "./dev.tsx";

describe("_startDevServer", () => {
  test("throws when no agent found", async () => {
    await withTempDir(async (dir) => {
      await expect(_startDevServer(dir, 3000, () => {})).rejects.toThrow("No agent found");
    });
  });

  test("error message suggests aai init", async () => {
    await withTempDir(async (dir) => {
      await expect(_startDevServer(dir, 3000, () => {})).rejects.toThrow("aai init");
    });
  });
});
