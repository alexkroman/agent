// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadAgentModule } from "./_bundler.ts";
import { withTempDir } from "./_test-utils.ts";

describe("loadAgentModule", () => {
  test("loads agent.ts default export", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "agent.ts"),
        `export default { name: "test-agent", systemPrompt: "Hello", greeting: "Hi", maxSteps: 5, tools: {} };`,
      );
      const agentDef = await loadAgentModule(dir);
      expect(agentDef.name).toBe("test-agent");
    });
  });

  test("throws when agent.ts is missing", async () => {
    await withTempDir(async (dir) => {
      await expect(loadAgentModule(dir)).rejects.toThrow("agent.ts");
    });
  });
});
