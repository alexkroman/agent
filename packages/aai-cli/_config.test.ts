// Copyright 2025 the AAI authors. MIT license.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readProjectConfig, writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

// Keep the real module surface (`log` is needed by _ui.ts) and stub the prompts.
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  password: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
}));

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

  test("throws a clear error for a corrupted project.json (never null)", async () => {
    await withTempDir(async (dir) => {
      // Returning null here would make deploy generate a NEW slug and orphan
      // the live deployment — corruption must be loud.
      const fsp = await import("node:fs/promises");
      const file = path.join(dir, ".aai", "project.json");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, "{ definitely not json");
      await expect(readProjectConfig(dir)).rejects.toThrow(`project.json is corrupted at ${file}`);
    });
  });
});

describe("getConfigDir", () => {
  // The suite-wide setup file sets AAI_CONFIG_DIR (see _test-setup.ts);
  // clear it here so the env-paths default is what's under test. VITEST is
  // pinned explicitly because one test below clears it, and `restoreMocks`
  // does not unstub env vars — leaving these order-dependent otherwise.
  beforeEach(() => {
    vi.stubEnv("AAI_CONFIG_DIR", "");
    vi.stubEnv("VITEST", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("AAI_CONFIG_DIR overrides everything", async () => {
    const { getConfigDir } = await import("./_config.ts");
    vi.stubEnv("AAI_CONFIG_DIR", "/tmp/aai-override");
    expect(getConfigDir()).toBe("/tmp/aai-override");
  });

  test("defaults to the env-paths config dir outside tests", async () => {
    const { getConfigDir } = await import("./_config.ts");
    const envPaths = (await import("env-paths")).default;
    vi.stubEnv("VITEST", "");
    expect(getConfigDir()).toBe(envPaths("aai", { suffix: "" }).config);
  });

  test("never resolves the developer's real config dir under vitest", async () => {
    // Fail-closed: a test that reaches approveServer/ensureApiKey without an
    // explicit AAI_CONFIG_DIR must not write to the real config. That file is
    // the trust anchor for `serverUrl` in `.aai/project.json`, so an approved
    // origin leaked there lets a cloned repo receive the developer's API key
    // with no prompt. This lives in the code path, not a vitest setup file,
    // because setup files are per-config and every config can omit one —
    // vitest.slow.config.ts did, which is how the real config got polluted.
    const { getConfigDir } = await import("./_config.ts");
    const envPaths = (await import("env-paths")).default;
    expect(process.env.VITEST).toBeTruthy();
    expect(getConfigDir()).not.toBe(envPaths("aai", { suffix: "" }).config);
  });

  test("the under-vitest fallback dir is stable within a process", async () => {
    // Callers read-modify-write the same config across calls; a fresh temp dir
    // per call would silently drop what the previous call wrote.
    const { getConfigDir } = await import("./_config.ts");
    expect(getConfigDir()).toBe(getConfigDir());
  });
});

describe("readGlobalConfig / writeGlobalConfig", () => {
  test("returns empty object when no config exists", async () => {
    await withTempDir(async (dir) => {
      const { readGlobalConfig } = await import("./_config.ts");
      const result = await readGlobalConfig(dir);
      expect(result).toEqual({});
    });
  });

  test("round-trips config data", async () => {
    await withTempDir(async (dir) => {
      const { readGlobalConfig, writeGlobalConfig } = await import("./_config.ts");
      await writeGlobalConfig(dir, { apiKey: "test-key-123" });
      const result = await readGlobalConfig(dir);
      expect(result).toEqual({ apiKey: "test-key-123" });
    });
  });

  test("creates config directory if missing (nested path)", async () => {
    await withTempDir(async (dir) => {
      const { readGlobalConfig, writeGlobalConfig } = await import("./_config.ts");
      const nested = path.join(dir, "deep", "nested", "config");
      await writeGlobalConfig(nested, { apiKey: "nested-key" });
      const result = await readGlobalConfig(nested);
      expect(result).toEqual({ apiKey: "nested-key" });
      expect(await fileExists(nested)).toBe(true);
    });
  });
});

describe("ensureApiKey", () => {
  // Several tests below export ASSEMBLYAI_API_KEY to prove it is ignored, and
  // `restoreMocks` does not unstub env vars.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns saved key without prompting", async () => {
    const p = await import("@clack/prompts");
    await withTempDir(async (dir) => {
      const { writeGlobalConfig, ensureApiKey } = await import("./_config.ts");
      await writeGlobalConfig(dir, { apiKey: "existing-key" });
      const key = await ensureApiKey(dir);
      expect(key).toBe("existing-key");
      expect(p.password).not.toHaveBeenCalled();
    });
    vi.mocked(p.password).mockReset();
  });

  /**
   * Pretend stdin is a TTY for the duration of `fn`. The prompt path is
   * gated on `process.stdin.isTTY` (a real non-TTY run must fail fast, not
   * prompt), and the test process itself has no TTY.
   */
  async function withTtyStdin(fn: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await fn();
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }

  test("directs an unauthenticated user to `aai login` instead of prompting", async () => {
    const p = await import("@clack/prompts");

    // Pasting a raw key is no longer an authentication path. `aai login`
    // links a real account (and is what the studio's own onboarding sets up),
    // so a pasted key produced a half-configured CLI that could push and
    // publish while belonging to no account the user could see.
    await withTtyStdin(() =>
      withTempDir(async (dir) => {
        const { ensureApiKey } = await import("./_config.ts");
        await expect(ensureApiKey(dir)).rejects.toMatchObject({
          code: "not_logged_in",
          hint: expect.stringContaining("aai login"),
        });
        expect(p.password).not.toHaveBeenCalled();
      }),
    );
  });

  test("refuses the same way with no TTY — the failure is not about prompting", async () => {
    const p = await import("@clack/prompts");

    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toMatchObject({
        code: "not_logged_in",
        hint: expect.stringContaining("aai login"),
      });
      expect(p.password).not.toHaveBeenCalled();
    });
  });

  /**
   * `ASSEMBLYAI_API_KEY` is NOT an authentication path. It used to be, and it
   * left the CLI authenticated as whatever key happened to be exported —
   * belonging to no account visible in the studio — and then PERSISTED that
   * key into the global config, so the CLI stayed logged in as it long after
   * the export was gone. In a project the same variable means a *provider*
   * credential in `.env` (see `aai dev`), which is why an export must not
   * quietly become a platform identity.
   */
  test("ignores an exported ASSEMBLYAI_API_KEY", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toMatchObject({
        code: "not_logged_in",
        hint: expect.stringContaining("aai login"),
      });
    });
  });

  test("does not write the exported key into the global config", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { readGlobalConfig, ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toThrow();
      // A refusal must leave no credential behind: a persisted env key would
      // authenticate every LATER invocation, export or not.
      expect((await readGlobalConfig(dir)).apiKey).toBeUndefined();
    });
  });

  test("the saved login key wins even with a different key exported", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { writeGlobalConfig, ensureApiKey } = await import("./_config.ts");
      await writeGlobalConfig(dir, { apiKey: "logged-in-key" });
      await expect(ensureApiKey(dir)).resolves.toBe("logged-in-key");
    });
  });
});
