// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, runBuildCommand } from "./_bundler.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent.json found in directory", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow(
        "Missing agent.json",
      );
    });
  });

  test("bundles minimal agent directory", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "build-test-agent" }));
        const bundle = await buildAgentBundle(dir);
        expect(bundle.manifest.name).toBe("build-test-agent");
        expect(bundle.toolBundles).toEqual({});
        expect(bundle.hookBundles).toEqual({});
      }),
    );
  });
});

describe("runBuildCommand", () => {
  test("throws when no agent.json found", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => runBuildCommand(dir))(dir)).rejects.toThrow("Missing agent.json");
    });
  });
});
