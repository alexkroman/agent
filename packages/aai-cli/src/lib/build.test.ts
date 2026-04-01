// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, runBuildCommand } from "./bundler.ts";
import { withTempDir } from "./test-utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent found in directory", async () => {
    await withTempDir(async (dir) => {
      await expect(buildAgentBundle(dir)).rejects.toThrow("No agent.toml found");
    });
  });

  test("throws with message suggesting aai init", async () => {
    await withTempDir(async (dir) => {
      await expect(buildAgentBundle(dir)).rejects.toThrow("run `aai init` first");
    });
  });

  test("wraps BundleError with context message", async () => {
    await withTempDir(async (dir) => {
      // Create an agent.toml that will cause a Vite build error (no tools.ts)
      await writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      try {
        await buildAgentBundle(dir);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Build failed");
      }
    });
  });
});

describe("runBuildCommand", () => {
  test("throws when no agent found", async () => {
    await withTempDir(async (dir) => {
      await expect(runBuildCommand(dir)).rejects.toThrow("No agent.toml found");
    });
  });
});
