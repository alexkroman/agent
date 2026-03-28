// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, runBuildCommand } from "./_build.ts";
import { withTempDir } from "./_test-utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent found in directory", async () => {
    await withTempDir(async (dir) => {
      await expect(
        buildAgentBundle(dir, () => {
          /* noop */
        }),
      ).rejects.toThrow("No agent found");
    });
  });

  test("throws with message suggesting aai init", async () => {
    await withTempDir(async (dir) => {
      await expect(
        buildAgentBundle(dir, () => {
          /* noop */
        }),
      ).rejects.toThrow("run `aai init` first");
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
      await writeFile(path.join(dir, "agent.ts"), "export default {}");
      try {
        await buildAgentBundle(dir, (node) => logs.push(node));
      } catch {
        // bundle will fail (no valid Vite project), but log should be called once
      }
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("wraps BundleError with context message", async () => {
    await withTempDir(async (dir) => {
      // Create an agent.ts that will cause a Vite build error
      await writeFile(path.join(dir, "agent.ts"), "export default {}");
      try {
        await buildAgentBundle(dir, () => {
          /* noop */
        });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Bundle failed");
      }
    });
  });
});

describe("runBuildCommand", () => {
  test("throws when no agent found", async () => {
    const origLog = console.log;
    console.log = () => {
      /* noop */
    };
    try {
      await withTempDir(async (dir) => {
        await expect(runBuildCommand(dir)).rejects.toThrow("No agent found");
      });
    } finally {
      console.log = origLog;
    }
  });
});
