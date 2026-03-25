// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { fileExists } from "./_discover.ts";
import { listTemplates, runInit } from "./_init.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

async function createFakeTemplates(dir: string): Promise<string> {
  const templatesDir = path.join(dir, "templates");
  const shared = path.join(templatesDir, "_shared");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "shared.txt"), "from shared");
  await fs.writeFile(path.join(shared, ".env.example"), "MY_KEY=");

  const simple = path.join(templatesDir, "simple");
  await fs.mkdir(simple, { recursive: true });
  await fs.writeFile(
    path.join(simple, "agent.ts"),
    'export default defineAgent({\n  name: "Default Name",\n});',
  );
  await fs.writeFile(path.join(simple, "readme.txt"), "hello");
  await fs.writeFile(path.join(simple, "package.json"), "{}");

  const advanced = path.join(templatesDir, "advanced");
  const sub = path.join(advanced, "tools");
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(
    path.join(advanced, "agent.ts"),
    'export default defineAgent({ name: "Advanced" });',
  );
  await fs.writeFile(path.join(sub, "helper.ts"), "// helper");

  const withEnv = path.join(templatesDir, "with-env");
  await fs.mkdir(withEnv, { recursive: true });
  await fs.writeFile(
    path.join(withEnv, "agent.ts"),
    'export default defineAgent({ name: "Env Agent" });',
  );
  await fs.writeFile(path.join(withEnv, ".env.example"), "CUSTOM_KEY=");

  return templatesDir;
}

describe("listTemplates", () => {
  test("returns sorted directory names excluding shared", async () => {
    await withTempDir(async (dir) => {
      const templatesDir = await createFakeTemplates(dir);
      expect(await listTemplates(templatesDir)).toEqual(["advanced", "simple", "with-env"]);
    });
  });

  test("returns empty for empty dir", async () => {
    await withTempDir(async (dir) => {
      expect(await listTemplates(dir)).toEqual([]);
    });
  });
});

describe("runInit", () => {
  test("copies template and shared files to target", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple", templatesDir });
        expect(await fs.readFile(path.join(target, "agent.ts"), "utf-8")).toContain("Default Name");
        expect(await fs.readFile(path.join(target, "readme.txt"), "utf-8")).toBe("hello");
        expect(await fs.readFile(path.join(target, "shared.txt"), "utf-8")).toBe("from shared");
      }),
    );
  });

  test("skips node_modules", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple", templatesDir });
        expect(await fileExists(path.join(target, "node_modules"))).toBe(false);
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("template files take precedence over shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "with-env", templatesDir });
        expect(await fs.readFile(path.join(target, ".env.example"), "utf-8")).toBe("CUSTOM_KEY=");
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("CUSTOM_KEY=");
      }),
    );
  });

  test("copies subdirectories recursively", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "advanced", templatesDir });
        expect(await fs.readFile(path.join(target, "tools", "helper.ts"), "utf-8")).toBe(
          "// helper",
        );
      }),
    );
  });

  test("copies .env.example to .env from shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple", templatesDir });
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
      }),
    );
  });

  test("throws for unknown template", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");
        await expect(
          runInit({ targetDir: target, template: "nonexistent", templatesDir }),
        ).rejects.toThrow("unknown template");
      }),
    );
  });
});
