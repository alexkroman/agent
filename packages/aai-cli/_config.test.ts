// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
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
  // clear it here so the injected legacy/modern dirs are what's under test.
  beforeEach(() => {
    vi.stubEnv("AAI_CONFIG_DIR", "");
  });

  test("AAI_CONFIG_DIR overrides everything", async () => {
    const { getConfigDir } = await import("./_config.ts");
    vi.stubEnv("AAI_CONFIG_DIR", "/tmp/aai-override");
    expect(getConfigDir({ legacy: "/l", modern: "/m" })).toBe("/tmp/aai-override");
  });

  test("prefers the legacy dir when a config file already exists there", async () => {
    await withTempDir(async (dir) => {
      const { getConfigDir, writeGlobalConfig } = await import("./_config.ts");
      const legacy = path.join(dir, "legacy");
      const modern = path.join(dir, "modern");
      await writeGlobalConfig(legacy, { apiKey: "old-key" });
      expect(getConfigDir({ legacy, modern })).toBe(legacy);
    });
  });

  test("uses the env-paths dir when no legacy config exists", async () => {
    await withTempDir(async (dir) => {
      const { getConfigDir } = await import("./_config.ts");
      const legacy = path.join(dir, "legacy");
      const modern = path.join(dir, "modern");
      expect(getConfigDir({ legacy, modern })).toBe(modern);
    });
  });

  test("ignores a legacy dir that exists but holds no config.json", async () => {
    await withTempDir(async (dir) => {
      const { getConfigDir } = await import("./_config.ts");
      const legacy = path.join(dir, "legacy");
      const modern = path.join(dir, "modern");
      fs.mkdirSync(legacy, { recursive: true });
      expect(getConfigDir({ legacy, modern })).toBe(modern);
    });
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

  test("prompts and saves when no key exists", async () => {
    // Isolate from the host shell: an exported ASSEMBLYAI_API_KEY would
    // short-circuit the prompt path and fail this test on developer machines.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    const p = await import("@clack/prompts");
    vi.mocked(p.password).mockResolvedValue("new-api-key");
    vi.mocked(p.isCancel).mockReturnValue(false);

    await withTtyStdin(() =>
      withTempDir(async (dir) => {
        const { readGlobalConfig, ensureApiKey } = await import("./_config.ts");
        const key = await ensureApiKey(dir);
        expect(key).toBe("new-api-key");
        expect(p.password).toHaveBeenCalledWith({ message: "Enter your AssemblyAI API key" });
        const saved = await readGlobalConfig(dir);
        expect(saved.apiKey).toBe("new-api-key");
      }),
    );
    vi.mocked(p.password).mockReset();
    vi.mocked(p.isCancel).mockReset();
  });

  test("fails fast (no prompt) when there is no key and no TTY", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    const p = await import("@clack/prompts");

    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      // The hidden password prompt would otherwise consume piped stdin as
      // keystrokes (e.g. eat the secret in `echo $V | aai secret put N`).
      await expect(ensureApiKey(dir)).rejects.toThrow(/no TTY/i);
      expect(p.password).not.toHaveBeenCalled();
    });
  });

  test("reads from ASSEMBLYAI_API_KEY env var and saves to config", async () => {
    const p = await import("@clack/prompts");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { readGlobalConfig, ensureApiKey } = await import("./_config.ts");
      const key = await ensureApiKey(dir);
      expect(key).toBe("env-var-key");
      expect(p.password).not.toHaveBeenCalled();
      const saved = await readGlobalConfig(dir);
      expect(saved.apiKey).toBe("env-var-key");
    });
    vi.mocked(p.password).mockReset();
  });

  test("still returns the env key (with a warning) when the config write fails", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");
    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      const fsp = (await import("node:fs/promises")).default;
      const writeSpy = vi
        .spyOn(fsp, "writeFile")
        .mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), {}));
      // Saving is best-effort — the key in hand still works for this run.
      await expect(ensureApiKey(dir)).resolves.toBe("env-var-key");
      expect(writeSpy).toHaveBeenCalled();
    });
  });

  test("calls cancel and exits when user cancels prompt", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    const p = await import("@clack/prompts");
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.password).mockResolvedValue(cancelSymbol as unknown as string);
    vi.mocked(p.isCancel).mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await withTtyStdin(() =>
      withTempDir(async (dir) => {
        const { ensureApiKey } = await import("./_config.ts");
        await expect(ensureApiKey(dir)).rejects.toThrow("process.exit");
        expect(p.cancel).toHaveBeenCalledWith("Setup cancelled");
        expect(exitSpy).toHaveBeenCalledWith(0);
      }),
    );
    exitSpy.mockRestore();
    vi.mocked(p.password).mockReset();
    vi.mocked(p.isCancel).mockReset();
    vi.mocked(p.cancel).mockReset();
  });
});
