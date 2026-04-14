// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

// Mock isDevMode — default to true so it resolves local templates.
// We use AAI_TEMPLATES_DIR env var to point to our fake templates root.
vi.mock("./_agent.ts", () => ({
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

const { downloadAndMergeTemplate } = await import("./_templates.ts");

/** Create a fake templates root directory with scaffold and templates. */
async function createFakeRoot(dir: string): Promise<string> {
  const rootDir = path.join(dir, "templates-root");

  // Create scaffold
  const scaffold = path.join(rootDir, "scaffold");
  await fs.mkdir(scaffold, { recursive: true });
  await fs.writeFile(path.join(scaffold, "tsconfig.json"), '{"compilerOptions":{}}');
  await fs.writeFile(
    path.join(scaffold, "package.json"),
    JSON.stringify({ name: "scaffold", dependencies: {} }),
  );
  await fs.writeFile(path.join(scaffold, ".env.example"), "API_KEY=");

  // Create "simple" template
  const simple = path.join(rootDir, "templates", "simple");
  await fs.mkdir(simple, { recursive: true });
  await fs.writeFile(path.join(simple, "agent.ts"), 'export default { name: "simple" };');

  // Create "web-researcher" template
  const webResearcher = path.join(rootDir, "templates", "web-researcher");
  await fs.mkdir(webResearcher, { recursive: true });
  await fs.writeFile(
    path.join(webResearcher, "agent.ts"),
    'export default { name: "web-researcher" };',
  );
  // Template-specific package.json that should take priority over scaffold
  await fs.writeFile(
    path.join(webResearcher, "package.json"),
    JSON.stringify({ name: "web-researcher-template", dependencies: { "node-fetch": "^3.0.0" } }),
  );

  return rootDir;
}

describe("downloadAndMergeTemplate", () => {
  test("copies template files to target directory", async () => {
    await withTempDir(async (dir) => {
      const root = await createFakeRoot(dir);
      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "output");
        await downloadAndMergeTemplate("simple", target);
        expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
        const content = await fs.readFile(path.join(target, "agent.ts"), "utf-8");
        expect(content).toContain("simple");
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });

  test("copies scaffold files underneath template files", async () => {
    await withTempDir(async (dir) => {
      const root = await createFakeRoot(dir);
      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "output");
        await downloadAndMergeTemplate("simple", target);
        // Scaffold files that don't conflict with template should be copied
        expect(await fileExists(path.join(target, "tsconfig.json"))).toBe(true);
        expect(await fileExists(path.join(target, ".env.example"))).toBe(true);
        // Scaffold package.json should also be present (simple template has no package.json)
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });

  test("template files take priority over scaffold files", async () => {
    await withTempDir(async (dir) => {
      const root = await createFakeRoot(dir);
      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "output");
        // web-researcher has its own package.json which should win over scaffold
        await downloadAndMergeTemplate("web-researcher", target);
        const pkgJson = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
        expect(pkgJson.name).toBe("web-researcher-template");
        expect(pkgJson.dependencies["node-fetch"]).toBe("^3.0.0");
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });

  test("throws for unknown template", async () => {
    await withTempDir(async (dir) => {
      const root = await createFakeRoot(dir);
      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "output");
        await expect(downloadAndMergeTemplate("nonexistent", target)).rejects.toThrow(
          'Unknown template "nonexistent"',
        );
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });

  test("error message lists available templates", async () => {
    await withTempDir(async (dir) => {
      const root = await createFakeRoot(dir);
      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "output");
        await expect(downloadAndMergeTemplate("bad-name", target)).rejects.toThrow(
          "Available templates: simple, web-researcher",
        );
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });

  test("creates target directory if it does not exist", async () => {
    await withTempDir(async (dir) => {
      const root = await createFakeRoot(dir);
      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "deeply", "nested", "output");
        // fs.cp with recursive:true creates the target directory
        await downloadAndMergeTemplate("simple", target);
        expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });

  test("handles template with no scaffold directory", async () => {
    await withTempDir(async (dir) => {
      // Create a root with templates but no scaffold
      const root = path.join(dir, "no-scaffold-root");
      const simple = path.join(root, "templates", "simple");
      await fs.mkdir(simple, { recursive: true });
      await fs.writeFile(path.join(simple, "agent.ts"), "export default {};");

      process.env.AAI_TEMPLATES_DIR = root;
      try {
        const target = path.join(dir, "output");
        // Should not throw even without scaffold dir
        await downloadAndMergeTemplate("simple", target);
        expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
      } finally {
        delete process.env.AAI_TEMPLATES_DIR;
      }
    });
  });
});
