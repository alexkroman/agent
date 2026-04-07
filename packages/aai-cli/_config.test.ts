// Copyright 2025 the AAI authors. MIT license.
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ensureApiKeyInEnv, readProjectConfig, writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

describe("readProjectConfig / writeProjectConfig", () => {
  test("returns null when no config exists", async () => {
    await withTempDir(async (dir) => {
      const result = await readProjectConfig(dir);
      expect(result).toBeNull();
    });
  });

  test("round-trips config data", async () => {
    await withTempDir(async (dir) => {
      const config = { slug: "test-slug", serverUrl: "https://example.com" };
      await writeProjectConfig(dir, config);
      const result = await readProjectConfig(dir);
      expect(result).toEqual(config);
    });
  });

  test("creates .aai directory if missing", async () => {
    await withTempDir(async (dir) => {
      const config = { slug: "slug", serverUrl: "https://example.com" };
      await writeProjectConfig(dir, config);
      const aaiDir = path.join(dir, ".aai");
      expect(await fileExists(aaiDir)).toBe(true);
    });
  });

  test("overwrites existing config", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "old", serverUrl: "https://old.com" });
      await writeProjectConfig(dir, { slug: "new", serverUrl: "https://new.com" });
      const result = await readProjectConfig(dir);
      expect(result?.slug).toBe("new");
    });
  });
});

describe("ensureApiKeyInEnv", () => {
  test("sets process.env.ASSEMBLYAI_API_KEY from env", async () => {
    const orig = process.env.ASSEMBLYAI_API_KEY;
    process.env.ASSEMBLYAI_API_KEY = "test-key-env";
    try {
      const key = await ensureApiKeyInEnv();
      expect(key).toBe("test-key-env");
      expect(process.env.ASSEMBLYAI_API_KEY).toBe("test-key-env");
    } finally {
      if (orig !== undefined) {
        process.env.ASSEMBLYAI_API_KEY = orig;
      } else {
        delete process.env.ASSEMBLYAI_API_KEY;
      }
    }
  });
});
