// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { patchPackageJsonForWorkspace } from "./_init.ts";
import { fakeDownloadAndMerge, silenced, withTempDir } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

async function createFakeTemplates(dir: string): Promise<string> {
  const rootDir = path.join(dir, "fake-root");
  const scaffold = path.join(rootDir, "scaffold");
  await fs.mkdir(scaffold, { recursive: true });
  await fs.writeFile(path.join(scaffold, "shared.txt"), "from shared");
  await fs.writeFile(path.join(scaffold, ".env.example"), "MY_KEY=");

  const simple = path.join(rootDir, "templates", "simple");
  await fs.mkdir(simple, { recursive: true });
  await fs.writeFile(
    path.join(simple, "agent.ts"),
    'export default defineAgent({\n  name: "Default Name",\n});',
  );
  await fs.writeFile(path.join(simple, "readme.txt"), "hello");
  await fs.writeFile(path.join(simple, "package.json"), "{}");

  return rootDir;
}

let fakeTemplatesDir: string;

vi.mock("./_templates.ts", () => ({
  downloadAndMergeTemplate: (template: string, targetDir: string) =>
    fakeDownloadAndMerge(fakeTemplatesDir, template, targetDir),
}));

const { runInit } = await import("./_init.ts");

describe("runInit", () => {
  test("copies template and shared files to target", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target });
        expect(await fs.readFile(path.join(target, "agent.ts"), "utf-8")).toContain("Default Name");
        expect(await fs.readFile(path.join(target, "readme.txt"), "utf-8")).toBe("hello");
        expect(await fs.readFile(path.join(target, "shared.txt"), "utf-8")).toBe("from shared");
      }),
    );
  });

  test("skips node_modules", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target });
        expect(await fileExists(path.join(target, "node_modules"))).toBe(false);
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("copies .env.example to .env from shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target });
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
      }),
    );
  });
});

describe("patchPackageJsonForWorkspace", () => {
  test("rewrites @alexkroman1/* deps to workspace:*", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "my-agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.29.3",
          dependencies: {
            "@alexkroman1/aai-core": "^0.12.3",
            "@alexkroman1/aai-ui": "^0.12.3",
            preact: "^10.29.0",
          },
          devDependencies: {
            "@alexkroman1/aai-cli": "^0.12.3",
            vitest: "^4.1.1",
          },
        }),
      );

      await patchPackageJsonForWorkspace(target);

      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(result.name).toBe("my-agent");
      expect(result.packageManager).toBeUndefined();
      expect(result.dependencies["@alexkroman1/aai-core"]).toBe("workspace:*");
      expect(result.dependencies["@alexkroman1/aai-ui"]).toBe("workspace:*");
      expect(result.dependencies.preact).toBe("^10.29.0");
      expect(result.devDependencies["@alexkroman1/aai-cli"]).toBe("workspace:*");
      expect(result.devDependencies.vitest).toBe("^4.1.1");
    });
  });
});
