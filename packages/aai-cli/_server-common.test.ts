// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseEnvFile, resolveServerEnv } from "./_server-common.ts";
import { withTempDir } from "./_test-utils.ts";

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

  test("trims whitespace around keys and values", () => {
    expect(parseEnvFile("  KEY  =  value  ")).toEqual({ KEY: "value" });
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

  test("returns empty env without .env file and no declared keys", async () => {
    const env = await resolveServerEnv(undefined, { ASSEMBLYAI_API_KEY: "test-key-123" });
    expect(env).toEqual({});
  });

  test("only includes keys declared in .env file", async () => {
    const env = await resolveServerEnv(undefined, {
      ASSEMBLYAI_API_KEY: "key",
      PATH: "/usr/bin",
    });
    expect(env).toEqual({});
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

  test("returns empty env when no .env file exists", async () => {
    await withTempDir(async (dir) => {
      const env = await resolveServerEnv(dir, { ASSEMBLYAI_API_KEY: "key", FOO: "bar" });
      expect(env).toEqual({});
    });
  });
});
