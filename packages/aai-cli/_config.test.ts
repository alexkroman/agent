// Copyright 2025 the AAI authors. MIT license.
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { readProjectConfig, writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

vi.mock("@clack/prompts", () => ({
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

  test("prompts and saves when no key exists", async () => {
    const p = await import("@clack/prompts");
    vi.mocked(p.password).mockResolvedValue("new-api-key");
    vi.mocked(p.isCancel).mockReturnValue(false);

    await withTempDir(async (dir) => {
      const { readGlobalConfig, ensureApiKey } = await import("./_config.ts");
      const key = await ensureApiKey(dir);
      expect(key).toBe("new-api-key");
      expect(p.password).toHaveBeenCalledWith({ message: "Enter your AssemblyAI API key" });
      const saved = await readGlobalConfig(dir);
      expect(saved.apiKey).toBe("new-api-key");
    });
    vi.mocked(p.password).mockReset();
    vi.mocked(p.isCancel).mockReset();
  });

  test("calls cancel and exits when user cancels prompt", async () => {
    const p = await import("@clack/prompts");
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.password).mockResolvedValue(cancelSymbol as unknown as string);
    vi.mocked(p.isCancel).mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toThrow("process.exit");
      expect(p.cancel).toHaveBeenCalledWith("Setup cancelled");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    exitSpy.mockRestore();
    vi.mocked(p.password).mockReset();
    vi.mocked(p.isCancel).mockReset();
    vi.mocked(p.cancel).mockReset();
  });
});
