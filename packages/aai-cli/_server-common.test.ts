// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadAgentDef, resolveServerEnv } from "./_server-common.ts";
import { withTempDir } from "./_test-utils.ts";

describe("resolveServerEnv", () => {
  test("returns env with existing ASSEMBLYAI_API_KEY", async () => {
    const env = await resolveServerEnv({ ASSEMBLYAI_API_KEY: "test-key-123" });
    expect(env.ASSEMBLYAI_API_KEY).toBe("test-key-123");
  });

  test("returned env contains all provided entries", async () => {
    const env = await resolveServerEnv({
      ASSEMBLYAI_API_KEY: "key",
      NODE_ENV: "test",
    });
    expect(env.NODE_ENV).toBe("test");
    expect(env.ASSEMBLYAI_API_KEY).toBe("key");
  });

  test("filters out undefined values", async () => {
    const env = await resolveServerEnv({
      ASSEMBLYAI_API_KEY: "key",
      MISSING: undefined,
    });
    expect(env).not.toHaveProperty("MISSING");
  });

  test("preserves multiple defined values", async () => {
    const env = await resolveServerEnv({
      ASSEMBLYAI_API_KEY: "key",
      FOO: "bar",
      BAZ: "qux",
    });
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
  });
});

describe("loadAgentDef", () => {
  test("throws when agent.ts does not exist", async () => {
    await withTempDir(async (dir) => {
      await expect(loadAgentDef(dir)).rejects.toThrow();
    });
  });

  test("throws when agent.ts has no default export", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export const foo = 42;");
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("throws when default export has no name", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default { instructions: 'hi' };");
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("returns agent def when using defineAgent", async () => {
    await withTempDir(async (dir) => {
      // Use defineAgent to match real usage
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        [
          `import { defineAgent } from "${import.meta.resolve("@alexkroman1/aai").replace("file://", "")}";`,
          `export default defineAgent({ name: "test-agent" });`,
        ].join("\n"),
      );
      const def = await loadAgentDef(dir);
      expect(def.name).toBe("test-agent");
    });
  });

  test("throws when default export is null", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default null;");
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("throws when default export is a string", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), 'export default "not an object";');
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });
});
