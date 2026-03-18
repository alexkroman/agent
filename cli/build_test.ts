// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test_utils.ts";
import { runBuild } from "./build.ts";

describe("runBuild", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await expect(runBuild({ agentDir: dir })).rejects.toThrow("No agent found");
    });
  });
});
