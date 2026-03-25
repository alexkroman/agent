// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { _startDevServer } from "./dev.ts";

describe("_startDevServer", () => {
  test("throws when no agent found", async () => {
    await withTempDir(async (dir) => {
      await expect(
        _startDevServer(dir, 3000, () => {
          /* noop */
        }),
      ).rejects.toThrow("No agent found");
    });
  });

  test("error message suggests aai init", async () => {
    await withTempDir(async (dir) => {
      await expect(
        _startDevServer(dir, 3000, () => {
          /* noop */
        }),
      ).rejects.toThrow("aai init");
    });
  });
});
