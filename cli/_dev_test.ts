// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { _startDevServer } from "./_dev.ts";
import { withTempDir } from "./_test_utils.ts";

describe("_startDevServer", () => {
  test("throws when no agent found", async () => {
    await withTempDir(async (dir) => {
      await expect(_startDevServer(dir, 3000)).rejects.toThrow("No agent found");
    });
  });
});
