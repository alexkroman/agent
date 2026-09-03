// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { resolveServerEnv } from "./_server-common.ts";
import { withTempDir } from "./_test-utils.ts";

describe("resolveServerEnv", () => {
  test("returns empty env without .env file and no declared keys", async () => {
    const env = await resolveServerEnv(undefined, { ASSEMBLYAI_API_KEY: "test-key-123" });
    expect(env).toEqual({});
  });

  test("only includes keys the .env file declares, never the rest of baseEnv", async () => {
    // With `cwd: undefined` this returned `{}` for ANY `baseEnv` — `fileEntries`
    // stays empty and the loop has nothing to iterate — so it was
    // indistinguishable from the two no-directory cases and passed however the
    // filter behaved. A real `.env` is what makes the filter observable.
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=from-file\n");
      const env = await resolveServerEnv(dir, {
        ASSEMBLYAI_API_KEY: "from-shell",
        PATH: "/usr/bin",
      });
      expect(env).toEqual({ ASSEMBLYAI_API_KEY: "from-shell" });
    });
  });

  test('a declared-but-blank key is dropped, not carried through as ""', async () => {
    // `.env.example` declares keys it has no value for, and `aai init` copies
    // that file to `.env` — so a blank line is the COMMON case, not an odd one.
    // Carrying `""` through is worse than dropping it:
    // `withHostCredentialFallback` fills a provider credential only where the
    // name is `undefined`, so an empty string silently defeated the host
    // fallback and the provider authenticated with "".
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=\nBRAVE_API_KEY=\n");
      const env = await resolveServerEnv(dir, {});
      expect(env).not.toHaveProperty("ASSEMBLYAI_API_KEY");
      expect(env).not.toHaveProperty("BRAVE_API_KEY");
    });
  });

  test("a blank .env line does not mask a value from the shell", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=\n");
      const env = await resolveServerEnv(dir, { ASSEMBLYAI_API_KEY: "from-shell" });
      expect(env.ASSEMBLYAI_API_KEY).toBe("from-shell");
    });
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
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".env"),
        "AAI_TEST_OVERRIDE=from-file\nASSEMBLYAI_API_KEY=key",
      );
      vi.stubEnv("AAI_TEST_OVERRIDE", "from-shell");
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
