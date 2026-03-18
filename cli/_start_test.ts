// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { _startProductionServer } from "./_start.ts";
import { withTempDir } from "./_test_utils.ts";

describe("_startProductionServer", () => {
  test("throws when build directory is missing", async () => {
    await withTempDir(async (dir) => {
      await expect(_startProductionServer(dir, 3000)).rejects.toThrow();
    });
  });
});
