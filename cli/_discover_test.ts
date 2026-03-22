// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVER,
  fileExists,
  generateSlug,
  isDevMode,
  loadAgent,
  readProjectConfig,
  resolveCwd,
  writeProjectConfig,
} from "./_discover.ts";
import { withTempDir } from "./_test_utils.ts";

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

// --- isDevMode ---

describe("isDevMode", () => {
  test("returns true when script ends with .ts", () => {
    expect(isDevMode("/path/to/script.ts")).toBe(true);
  });

  test("returns true when script ends with .tsx", () => {
    expect(isDevMode("/path/to/script.tsx")).toBe(true);
  });

  test("returns false when script ends with .js", () => {
    expect(isDevMode("/path/to/dist/cli.js")).toBe(false);
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
});

// --- loadAgent ---

describe("loadAgent", () => {
  test("returns null when no agent.ts exists", async () => {
    await withTempDir(async (dir) => {
      const result = await loadAgent(dir);
      expect(result).toBeNull();
    });
  });

  test("returns agent entry when agent.ts exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      const result = await loadAgent(dir);
      expect(result).not.toBeNull();
      expect(result?.dir).toBe(dir);
      expect(result?.entryPoint).toBe(path.join(dir, "agent.ts"));
      expect(result?.slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    });
  });

  test("uses slug from project config when available", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: "https://example.com" });
      const result = await loadAgent(dir);
      expect(result?.slug).toBe("my-agent");
    });
  });

  test("includes client entry when client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      await fs.writeFile(path.join(dir, "client.tsx"), "export default {}");
      const result = await loadAgent(dir);
      expect(result?.clientEntry).toBe(path.join(dir, "client.tsx"));
    });
  });

  test("client entry is empty string when no client.tsx", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      const result = await loadAgent(dir);
      expect(result?.clientEntry).toBe("");
    });
  });
});
