// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withTempDir, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

// Mock isDevMode — default to false so it resolves via AAI_TEMPLATES_DIR,
// which we point at our fake templates root.
vi.mock("./_agent.ts", () => ({
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

const { downloadAndMergeTemplate } = await import("./_templates.ts");

/** Create a fake templates root with scaffold + two templates, and point resolution at it. */
async function useFakeRoot(dir: string): Promise<void> {
  const rootDir = await writeFiles(path.join(dir, "templates-root"), {
    "scaffold/tsconfig.json": '{"compilerOptions":{}}',
    "scaffold/package.json": JSON.stringify({ name: "scaffold", dependencies: {} }),
    "scaffold/.env.example": "API_KEY=",
    "templates/simple/agent.ts": 'export default { name: "simple" };',
    "templates/web-researcher/agent.ts": 'export default { name: "web-researcher" };',
    // Template-specific package.json that should take priority over scaffold
    "templates/web-researcher/package.json": JSON.stringify({
      name: "web-researcher-template",
      dependencies: { "node-fetch": "^3.0.0" },
    }),
  });
  vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("downloadAndMergeTemplate", () => {
  test("copies template files to target directory", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await downloadAndMergeTemplate("simple", target);
      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
      const content = await fs.readFile(path.join(target, "agent.ts"), "utf-8");
      expect(content).toContain("simple");
    });
  });

  test("copies scaffold files underneath template files", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await downloadAndMergeTemplate("simple", target);
      // Scaffold files that don't conflict with template should be copied
      expect(await fileExists(path.join(target, "tsconfig.json"))).toBe(true);
      expect(await fileExists(path.join(target, ".env.example"))).toBe(true);
      // Scaffold package.json should also be present (simple template has no package.json)
      expect(await fileExists(path.join(target, "package.json"))).toBe(true);
    });
  });

  test("template files take priority over scaffold files", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      // web-researcher has its own package.json which should win over scaffold
      await downloadAndMergeTemplate("web-researcher", target);
      const pkgJson = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(pkgJson.name).toBe("web-researcher-template");
      expect(pkgJson.dependencies["node-fetch"]).toBe("^3.0.0");
    });
  });

  test("throws for unknown template", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await expect(downloadAndMergeTemplate("nonexistent", target)).rejects.toThrow(
        'Unknown template "nonexistent"',
      );
    });
  });

  test("error message lists available templates", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await expect(downloadAndMergeTemplate("bad-name", target)).rejects.toThrow(
        "Available templates: simple, web-researcher",
      );
    });
  });

  test("creates target directory if it does not exist", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "deeply", "nested", "output");
      // fs.cp with recursive:true creates the target directory
      await downloadAndMergeTemplate("simple", target);
      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
    });
  });

  test("handles template with no scaffold directory", async () => {
    await withTempDir(async (dir) => {
      // Create a root with templates but no scaffold
      const root = await writeFiles(path.join(dir, "no-scaffold-root"), {
        "templates/simple/agent.ts": "export default {};",
      });
      vi.stubEnv("AAI_TEMPLATES_DIR", root);

      const target = path.join(dir, "output");
      // Should not throw even without scaffold dir
      await downloadAndMergeTemplate("simple", target);
      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
    });
  });
});
