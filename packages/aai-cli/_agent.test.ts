// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_SERVER, getServerInfo, isDevMode, resolveServerUrl } from "./_agent.ts";
import { writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";

test("DEFAULT_SERVER", () => {
  expect(DEFAULT_SERVER).toBe("https://aai-agent.fly.dev");
});

describe("resolveServerUrl", () => {
  test("explicit URL takes priority", () => {
    expect(resolveServerUrl("https://custom.com", "https://config.com")).toBe("https://custom.com");
  });

  test("dev mode takes priority over config URL", () => {
    // Tests run from the monorepo, so isDevMode() returns true
    expect(resolveServerUrl(undefined, "https://config.com")).toBe("http://localhost:8080");
  });
});

describe("getServerInfo", () => {
  test("throws when no project config exists", async () => {
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("No .aai/project.json found");
    });
  });

  test("error message suggests aai deploy", async () => {
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("aai deploy");
    });
  });

  test("returns config with explicit api key (no prompt)", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, {
        slug: "my-agent",
        serverUrl: "https://my-server.com",
      });
      const info = await getServerInfo(dir, undefined, "test-key-123");
      expect(info.slug).toBe("my-agent");
      // Dev mode (monorepo) takes priority over config serverUrl
      expect(info.serverUrl).toBe("http://localhost:8080");
      expect(info.apiKey).toBe("test-key-123");
    });
  });

  test("explicit server overrides config server", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, {
        slug: "agent",
        serverUrl: "https://config-server.com",
      });
      const info = await getServerInfo(dir, "https://override.com", "key");
      expect(info.serverUrl).toBe("https://override.com");
    });
  });
});

describe("isDevMode", () => {
  test("returns true when running from monorepo", () => {
    expect(isDevMode()).toBe(true);
  });
});
