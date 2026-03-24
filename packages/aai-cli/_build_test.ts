// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { buildAgentBundle } from "./_build.tsx";
import { withTempDir } from "./_test_utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent found in directory", async () => {
    await withTempDir(async (dir) => {
      await expect(buildAgentBundle(dir, () => {})).rejects.toThrow("No agent found");
    });
  });

  test("throws with message suggesting aai init", async () => {
    await withTempDir(async (dir) => {
      await expect(buildAgentBundle(dir, () => {})).rejects.toThrow("run `aai init` first");
    });
  });

  test("log is not called when agent is missing", async () => {
    const logs: unknown[] = [];
    await withTempDir(async (dir) => {
      try {
        await buildAgentBundle(dir, (node) => logs.push(node));
      } catch {
        // expected
      }
      expect(logs).toHaveLength(0);
    });
  });

  test("calls log when agent.ts exists (before bundle fails)", async () => {
    const logs: unknown[] = [];
    await withTempDir(async (dir) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "agent.ts"), "export default {}");
      try {
        await buildAgentBundle(dir, (node) => logs.push(node));
      } catch {
        // bundle will fail (no valid Vite project), but log should be called once
      }
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
