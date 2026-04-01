// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVER,
  ensureApiKeyInEnv,
  fileExists,
  generateSlug,
  getServerInfo,
  isDevMode,
  loadAgentEntry,
  readProjectConfig,
  resolveCwd,
  resolveServerUrl,
  writeProjectConfig,
} from "./discover.ts";
import { withTempDir } from "./test-utils.ts";

// --- resolveCwd ---

describe("resolveCwd", () => {
  test("returns INIT_CWD when set", () => {
    const orig = process.env.INIT_CWD;
    process.env.INIT_CWD = "/custom/path";
    try {
      expect(resolveCwd()).toBe("/custom/path");
    } finally {
      if (orig !== undefined) {
        process.env.INIT_CWD = orig;
      } else {
        delete process.env.INIT_CWD;
      }
    }
  });

  test("falls back to process.cwd() when INIT_CWD is not set", () => {
    const orig = process.env.INIT_CWD;
    delete process.env.INIT_CWD;
    try {
      expect(resolveCwd()).toBe(process.cwd());
    } finally {
      if (orig !== undefined) {
        process.env.INIT_CWD = orig;
      }
    }
  });
});

// --- generateSlug ---

describe("generateSlug", () => {
  test("returns a lowercase hyphenated string", () => {
    const slug = generateSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  test("generates different slugs on each call", () => {
    const slugs = new Set(Array.from({ length: 10 }, () => generateSlug()));
    expect(slugs.size > 1).toBe(true);
  });
});

test("DEFAULT_SERVER", () => {
  expect(DEFAULT_SERVER).toBe("https://aai-agent.fly.dev");
});

// --- resolveServerUrl ---

describe("resolveServerUrl", () => {
  test("explicit URL takes priority", () => {
    expect(resolveServerUrl("https://custom.com", "https://config.com")).toBe("https://custom.com");
  });

  test("dev mode takes priority over config URL", () => {
    // Tests run from the monorepo, so isDevMode() returns true
    expect(resolveServerUrl(undefined, "https://config.com")).toBe("http://localhost:8787");
  });
});

// --- fileExists ---

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "exists.txt");
      await fs.writeFile(p, "");
      expect(await fileExists(p)).toBe(true);
    });
  });

  test("returns false for missing file", async () => {
    expect(await fileExists("/tmp/does-not-exist-12345")).toBe(false);
  });

  test("returns true for existing directory", async () => {
    await withTempDir(async (dir) => {
      expect(await fileExists(dir)).toBe(true);
    });
  });
});

// --- readProjectConfig / writeProjectConfig ---

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

// --- getServerInfo ---

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
      expect(info.serverUrl).toBe("http://localhost:8787");
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

// --- ensureApiKeyInEnv ---

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

// --- isDevMode ---

describe("isDevMode", () => {
  test("returns true when running from monorepo", () => {
    // Tests run from the monorepo, so this should be true
    expect(isDevMode()).toBe(true);
  });
});

// --- loadAgentEntry ---

describe("loadAgentEntry", () => {
  test("returns null when no agent.toml exists", async () => {
    await withTempDir(async (dir) => {
      const result = await loadAgentEntry(dir);
      expect(result).toBeNull();
    });
  });

  test("returns agent entry when agent.toml exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      const result = await loadAgentEntry(dir);
      expect(result).not.toBeNull();
      expect(result?.dir).toBe(dir);
      expect(result?.tomlPath).toBe(path.join(dir, "agent.toml"));
      expect(result?.slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    });
  });

  test("uses slug from project config when available", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: "https://example.com" });
      const result = await loadAgentEntry(dir);
      expect(result?.slug).toBe("my-agent");
    });
  });

  test("includes client entry when index.html exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      await fs.writeFile(path.join(dir, "index.html"), "<html></html>");
      const result = await loadAgentEntry(dir);
      expect(result?.clientEntry).toBe(path.join(dir, "index.html"));
    });
  });

  test("client entry is empty string when no index.html", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      const result = await loadAgentEntry(dir);
      expect(result?.clientEntry).toBe("");
    });
  });

  test("includes tools entry when tools.ts exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      await fs.writeFile(path.join(dir, "tools.ts"), "export default {}");
      const result = await loadAgentEntry(dir);
      expect(result?.toolsEntry).toBe(path.join(dir, "tools.ts"));
    });
  });

  test("tools entry is empty string when no tools.ts", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.toml"), 'name = "test"');
      const result = await loadAgentEntry(dir);
      expect(result?.toolsEntry).toBe("");
    });
  });
});
