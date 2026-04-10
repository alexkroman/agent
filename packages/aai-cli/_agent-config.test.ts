// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveAgentConfig } from "./_agent-config.ts";
import { withTempDir } from "./_test-utils.ts";

describe("resolveAgentConfig", () => {
  test("reads agent.json and returns parsed config", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "agent.json"),
        JSON.stringify({ name: "test-agent", systemPrompt: "Hello" }),
      );
      const config = await resolveAgentConfig(dir);
      expect(config).toEqual({ name: "test-agent", systemPrompt: "Hello" });
    });
  });

  test("resolves $ref in systemPrompt", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "system-prompt.md"), "You are helpful.");
      await writeFile(
        path.join(dir, "agent.json"),
        JSON.stringify({ name: "ref-agent", systemPrompt: { $ref: "system-prompt.md" } }),
      );
      const config = await resolveAgentConfig(dir);
      expect(config.systemPrompt).toBe("You are helpful.");
    });
  });

  test("throws when agent.json is missing", async () => {
    await withTempDir(async (dir) => {
      await expect(resolveAgentConfig(dir)).rejects.toThrow("Missing agent.json");
    });
  });

  test("throws when name field is missing", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "agent.json"), JSON.stringify({ systemPrompt: "Hi" }));
      await expect(resolveAgentConfig(dir)).rejects.toThrow("must have a name");
    });
  });
});
