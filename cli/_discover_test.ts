// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVER,
  ensureClaudeMd,
  ensureDependencies,
  fileExists,
  generateSlug,
  isDevMode,
  loadAgent,
  readProjectConfig,
  writeProjectConfig,
} from "./_discover.ts";
import { silenceSteps, withTempDir } from "./_test_utils.ts";

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
  test("returns true when argv[1] ends with .ts", () => {
    const orig = process.argv[1];
    process.argv[1] = "/path/to/script.ts";
    try {
      expect(isDevMode()).toBe(true);
    } finally {
      process.argv[1] = orig;
    }
  });

  test("returns true when argv[1] ends with .tsx", () => {
    const orig = process.argv[1];
    process.argv[1] = "/path/to/script.tsx";
    try {
      expect(isDevMode()).toBe(true);
    } finally {
      process.argv[1] = orig;
    }
  });

  test("returns false when argv[1] ends with .js", () => {
    const orig = process.argv[1];
    process.argv[1] = "/path/to/dist/cli.js";
    try {
      expect(isDevMode()).toBe(false);
    } finally {
      process.argv[1] = orig;
    }
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

// --- ensureClaudeMd ---

describe("ensureClaudeMd", () => {
  test("creates CLAUDE.md when it does not exist", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        await ensureClaudeMd(dir);
        const content = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf-8");
        expect(content.length).toBeGreaterThan(0);
      });
    } finally {
      s.restore();
    }
  });

  test("does not overwrite when content matches", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        await ensureClaudeMd(dir);
        const stat1 = await fs.stat(path.join(dir, "CLAUDE.md"));
        await ensureClaudeMd(dir);
        const stat2 = await fs.stat(path.join(dir, "CLAUDE.md"));
        expect(stat2.size).toBe(stat1.size);
      });
    } finally {
      s.restore();
    }
  });

  test("updates CLAUDE.md when content differs", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        await fs.writeFile(path.join(dir, "CLAUDE.md"), "old content");
        await ensureClaudeMd(dir);
        const content = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf-8");
        expect(content).not.toBe("old content");
      });
    } finally {
      s.restore();
    }
  });
});

// --- ensureDependencies ---

describe("ensureDependencies", () => {
  test("skips install when node_modules exists", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "node_modules"));
      await ensureDependencies(dir);
    });
  });

  test("attempts npm install when node_modules missing", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        // No package.json so npm install will fail, but ensureDependencies catches it
        await ensureDependencies(dir);
      });
    } finally {
      s.restore();
    }
  });
});
