// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { fileExists } from "./_discover.ts";
import { fakeDownloadAndMerge, fakeListTemplates, silenced, withTempDir } from "./_test-utils.ts";

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

  const advanced = path.join(rootDir, "templates", "advanced");
  const sub = path.join(advanced, "tools");
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(
    path.join(advanced, "agent.ts"),
    'export default defineAgent({ name: "Advanced" });',
  );
  await fs.writeFile(path.join(sub, "helper.ts"), "// helper");

  const withEnv = path.join(rootDir, "templates", "with-env");
  await fs.mkdir(withEnv, { recursive: true });
  await fs.writeFile(
    path.join(withEnv, "agent.ts"),
    'export default defineAgent({ name: "Env Agent" });',
  );
  await fs.writeFile(path.join(withEnv, ".env.example"), "CUSTOM_KEY=");

  return rootDir;
}

let fakeTemplatesDir: string;

vi.mock("./_templates.ts", () => ({
  listTemplates: () => fakeListTemplates(fakeTemplatesDir),
  downloadAndMergeTemplate: (template: string, targetDir: string) =>
    fakeDownloadAndMerge(fakeTemplatesDir, template, targetDir),
}));

const { listTemplates } = await import("./_templates.ts");
const { runInit } = await import("./_init.ts");

describe("listTemplates", () => {
  test("returns sorted template directory names", async () => {
    await withTempDir(async (dir) => {
      fakeTemplatesDir = await createFakeTemplates(dir);
      expect(await listTemplates()).toEqual(["advanced", "simple", "with-env"]);
    });
  });

  test("returns empty for empty dir", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "templates"), { recursive: true });
      fakeTemplatesDir = dir;
      expect(await listTemplates()).toEqual([]);
    });
  });
});

describe("runInit", () => {
  test("copies template and shared files to target", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
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
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, "node_modules"))).toBe(false);
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("template files take precedence over shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "with-env" });
        expect(await fs.readFile(path.join(target, ".env.example"), "utf-8")).toBe("CUSTOM_KEY=");
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("CUSTOM_KEY=");
      }),
    );
  });

  test("copies subdirectories recursively", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "advanced" });
        expect(await fs.readFile(path.join(target, "tools", "helper.ts"), "utf-8")).toBe(
          "// helper",
        );
      }),
    );
  });

  test("copies .env.example to .env from shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
      }),
    );
  });

  test("throws for unknown template", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await expect(runInit({ targetDir: target, template: "nonexistent" })).rejects.toThrow(
          "Unknown template",
        );
      }),
    );
  });
});
