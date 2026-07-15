// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { patchPackageJsonForWorkspace, runInit } from "./_init.ts";
import { silenced, withTempDir, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

/** Create a fake templates root with a simple template and scaffold, and point runInit at it. */
async function useFakeTemplates(dir: string): Promise<void> {
  const rootDir = await writeFiles(path.join(dir, "fake-root"), {
    "scaffold/.env.example": "ASSEMBLYAI_API_KEY=",
    "scaffold/package.json": JSON.stringify({
      name: "scaffold-pkg",
      dependencies: { "@alexkroman1/aai": "^1.0.0" },
    }),
    "templates/simple/agent.ts": 'export default { name: "test" };',
  });
  vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runInit", () => {
  test("creates .env from .env.example", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "my-agent");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        const content = await fs.readFile(path.join(target, ".env"), "utf-8");
        expect(content).toBe("ASSEMBLYAI_API_KEY=");
      }),
    );
  });

  test("creates README.md with project name", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "cool-agent");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, "README.md"))).toBe(true);
        const readme = await fs.readFile(path.join(target, "README.md"), "utf-8");
        expect(readme).toContain("# cool-agent");
      }),
    );
  });

  test("does not overwrite existing README.md", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "my-agent");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "README.md"), "existing content");
        await runInit({ targetDir: target, template: "simple" });
        const readme = await fs.readFile(path.join(target, "README.md"), "utf-8");
        expect(readme).toBe("existing content");
      }),
    );
  });

  test("throws for unknown template", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await expect(runInit({ targetDir: target, template: "nonexistent" })).rejects.toThrow(
          'Unknown template "nonexistent"',
        );
      }),
    );
  });

  test("handles missing .env.example gracefully", async () => {
    await withTempDir(
      silenced(async (dir) => {
        // Create templates without .env.example
        const rootDir = await writeFiles(path.join(dir, "fake-root"), {
          "templates/simple/agent.ts": "export default {};",
        });
        vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);

        const target = path.join(dir, "output");
        // Should not throw even without .env.example
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, ".env"))).toBe(false);
      }),
    );
  });
});

describe("patchPackageJsonForWorkspace", () => {
  test("no-ops when package.json does not exist", async () => {
    await withTempDir(async (dir) => {
      // Should not throw
      await patchPackageJsonForWorkspace(dir);
    });
  });

  test("sets name to basename of target directory", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "my-cool-agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({ name: "original-name" }),
      );
      await patchPackageJsonForWorkspace(target);
      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(result.name).toBe("my-cool-agent");
    });
  });

  test("removes packageManager field", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({ name: "x", packageManager: "pnpm@10.0.0" }),
      );
      await patchPackageJsonForWorkspace(target);
      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(result.packageManager).toBeUndefined();
    });
  });

  test("preserves non-workspace dependencies", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({
          dependencies: { preact: "^10.0.0", zod: "^3.0.0" },
        }),
      );
      await patchPackageJsonForWorkspace(target);
      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(result.dependencies.preact).toBe("^10.0.0");
      expect(result.dependencies.zod).toBe("^3.0.0");
    });
  });
});
