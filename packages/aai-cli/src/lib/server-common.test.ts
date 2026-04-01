// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadAgent, parseEnvFile, resolveServerEnv } from "./server-common.ts";
import { withTempDir } from "./test-utils.ts";

describe("parseEnvFile", () => {
  test("parses KEY=VALUE lines into entries", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips comments and blank lines", () => {
    expect(parseEnvFile("# comment\n\nFOO=bar\n  # another")).toEqual({ FOO: "bar" });
  });

  test("handles empty values", () => {
    expect(parseEnvFile("KEY=")).toEqual({ KEY: "" });
  });

  test("trims whitespace around keys", () => {
    expect(parseEnvFile("  KEY  =  value  ")).toEqual({ KEY: "  value" });
  });

  test("skips lines without =", () => {
    expect(parseEnvFile("NOEQ\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});

describe("resolveServerEnv", () => {
  // Clean up env vars set directly by tests (e.g. shell-override test)
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

describe("loadAgent", () => {
  test("throws when agent.toml does not exist", async () => {
    await withTempDir(async (dir) => {
      await expect(loadAgent(dir)).rejects.toThrow("agent.toml not found");
    });
  });

  test("returns agent def with correct fields from agent.toml", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.toml"),
        'name = "test-agent"\nsystem_prompt = "You are helpful."\ngreeting = "Hello!"\nmax_steps = 3',
      );
      const def = await loadAgent(dir);
      expect(def.name).toBe("test-agent");
      expect(def.systemPrompt).toBe("You are helpful.");
      expect(def.greeting).toBe("Hello!");
      expect(def.maxSteps).toBe(3);
    });
  });

  test("applies defaults for optional fields", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "minimal"');
      const def = await loadAgent(dir);
      expect(def.name).toBe("minimal");
      expect(def.systemPrompt).toBeDefined();
      expect(def.greeting).toBeDefined();
      expect(def.tools).toEqual({});
    });
  });

  test("throws when name is missing from agent.toml", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'greeting = "hi"');
      await expect(loadAgent(dir)).rejects.toThrow("name");
    });
  });
});
