// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { envFileKeys, loadAgentDef, resolveServerEnv } from "./_server-common.ts";
import { withTempDir } from "./_test-utils.ts";

describe("envFileKeys", () => {
  test("extracts key names from KEY=VALUE lines", () => {
    expect(envFileKeys("FOO=bar\nBAZ=qux")).toEqual(["FOO", "BAZ"]);
  });

  test("skips comments and blank lines", () => {
    expect(envFileKeys("# comment\n\nFOO=bar\n  # another")).toEqual(["FOO"]);
  });

  test("handles empty values", () => {
    expect(envFileKeys("KEY=")).toEqual(["KEY"]);
  });

  test("trims whitespace around keys", () => {
    expect(envFileKeys("  KEY  =  value  ")).toEqual(["KEY"]);
  });

  test("skips lines without =", () => {
    expect(envFileKeys("NOEQ\nFOO=bar")).toEqual(["FOO"]);
  });
});

describe("resolveServerEnv", () => {
  // process.loadEnvFile mutates process.env, so clean up after .env tests
  const injectedKeys: string[] = [];
  afterEach(() => {
    for (const key of injectedKeys) delete process.env[key];
    injectedKeys.length = 0;
  });

  test("includes ASSEMBLYAI_API_KEY even without .env file", async () => {
    const env = await resolveServerEnv(undefined, { ASSEMBLYAI_API_KEY: "test-key-123" });
    expect(env.ASSEMBLYAI_API_KEY).toBe("test-key-123");
  });

  test("only includes declared keys, not all of baseEnv", async () => {
    const env = await resolveServerEnv(undefined, {
      ASSEMBLYAI_API_KEY: "key",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });
    // Only ASSEMBLYAI_API_KEY should be present, not PATH/HOME
    expect(env.ASSEMBLYAI_API_KEY).toBe("key");
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("HOME");
  });

  test("loads only declared keys from .env file", async () => {
    injectedKeys.push("AAI_TEST_SECRET", "ASSEMBLYAI_API_KEY");
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".env"),
        "AAI_TEST_SECRET=from-dotenv\nASSEMBLYAI_API_KEY=key",
      );
      const env = await resolveServerEnv(dir);
      expect(env.AAI_TEST_SECRET).toBe("from-dotenv");
      expect(env.ASSEMBLYAI_API_KEY).toBe("key");
      // System vars should not leak in
      expect(env).not.toHaveProperty("PATH");
      expect(env).not.toHaveProperty("HOME");
    });
  });

  test("shell env overrides .env values for declared keys", async () => {
    injectedKeys.push("AAI_TEST_OVERRIDE", "ASSEMBLYAI_API_KEY");
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".env"),
        "AAI_TEST_OVERRIDE=from-file\nASSEMBLYAI_API_KEY=key",
      );
      process.env.AAI_TEST_OVERRIDE = "from-shell";
      const env = await resolveServerEnv(dir);
      expect(env.AAI_TEST_OVERRIDE).toBe("from-shell");
    });
  });

  test("returns only ASSEMBLYAI_API_KEY when no .env file exists", async () => {
    await withTempDir(async (dir) => {
      const env = await resolveServerEnv(dir, { ASSEMBLYAI_API_KEY: "key", FOO: "bar" });
      expect(env).toEqual({ ASSEMBLYAI_API_KEY: "key" });
    });
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

  test("throws when required fields are missing from plain object", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), 'export default { name: "test" };');
      await expect(loadAgentDef(dir)).rejects.toThrow("Invalid agent definition");
      await expect(loadAgentDef(dir)).rejects.toThrow("instructions (string)");
      await expect(loadAgentDef(dir)).rejects.toThrow("greeting (string)");
      await expect(loadAgentDef(dir)).rejects.toThrow("maxSteps (number or function)");
      await expect(loadAgentDef(dir)).rejects.toThrow("tools (object)");
    });
  });

  test("throws when tools is an array instead of object", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        'export default { name: "test", instructions: "hi", greeting: "hello", maxSteps: 5, tools: [] };',
      );
      await expect(loadAgentDef(dir)).rejects.toThrow("tools (object)");
    });
  });

  test("accepts valid plain object with all required fields", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        'export default { name: "test", instructions: "hi", greeting: "hello", maxSteps: 5, tools: {} };',
      );
      const def = await loadAgentDef(dir);
      expect(def.name).toBe("test");
    });
  });

  test("suggests using defineAgent in error message", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), 'export default { name: "test" };');
      await expect(loadAgentDef(dir)).rejects.toThrow("Use defineAgent()");
    });
  });
});
