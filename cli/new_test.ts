// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { listTemplates, runNew } from "./_new.ts";
import { silenceSteps, withTempDir } from "./_test_utils.ts";

async function createFakeTemplates(dir: string): Promise<string> {
  const templatesDir = path.join(dir, "templates");

  // shared files
  const shared = path.join(templatesDir, "_shared");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "shared.txt"), "from shared");
  await fs.writeFile(path.join(shared, ".env.example"), "MY_KEY=");

  // simple template
  const simple = path.join(templatesDir, "simple");
  await fs.mkdir(simple, { recursive: true });
  await fs.writeFile(
    path.join(simple, "agent.ts"),
    'export default defineAgent({\n  name: "Default Name",\n});',
  );
  await fs.writeFile(path.join(simple, "readme.txt"), "hello");

  // template with subdirectory
  const advanced = path.join(templatesDir, "advanced");
  const sub = path.join(advanced, "tools");
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(
    path.join(advanced, "agent.ts"),
    'export default defineAgent({ name: "Advanced" });',
  );
  await fs.writeFile(path.join(sub, "helper.ts"), "// helper");

  await fs.writeFile(path.join(simple, "package.json"), "{}");

  // template with .env.example that overrides shared
  const withEnv = path.join(templatesDir, "with-env");
  await fs.mkdir(withEnv, { recursive: true });
  await fs.writeFile(
    path.join(withEnv, "agent.ts"),
    'export default defineAgent({ name: "Env Agent" });',
  );
  await fs.writeFile(path.join(withEnv, ".env.example"), "CUSTOM_KEY=");

  return templatesDir;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// --- listTemplates ---

describe("listTemplates", () => {
  test("returns sorted directory names excluding shared", async () => {
    await withTempDir(async (dir) => {
      const templatesDir = await createFakeTemplates(dir);
      const result = await listTemplates(templatesDir);
      expect(result).toEqual(["advanced", "simple", "with-env"]);
    });
  });

  test("returns empty for empty dir", async () => {
    await withTempDir(async (dir) => {
      const result = await listTemplates(dir);
      expect(result).toEqual([]);
    });
  });
});

// --- runNew ---

describe("runNew", () => {
  test("copies template and shared files to target", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");

        await runNew({
          targetDir: target,
          template: "simple",
          templatesDir,
        });

        const agent = await fs.readFile(path.join(target, "agent.ts"), "utf-8");
        expect(agent).toContain("Default Name");

        const readme = await fs.readFile(path.join(target, "readme.txt"), "utf-8");
        expect(readme).toBe("hello");

        // shared file should be present
        const shared = await fs.readFile(path.join(target, "shared.txt"), "utf-8");
        expect(shared).toBe("from shared");
      });
    } finally {
      s.restore();
    }
  });

  test("skips node_modules", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");

        await runNew({
          targetDir: target,
          template: "simple",
          templatesDir,
        });

        expect(await fileExists(path.join(target, "node_modules"))).toBe(false);
        // package.json should be copied (used for deps + config)
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      });
    } finally {
      s.restore();
    }
  });

  test("template files take precedence over shared", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");

        // with-env has its own .env.example that should NOT be overwritten by shared
        await runNew({
          targetDir: target,
          template: "with-env",
          templatesDir,
        });

        const env = await fs.readFile(path.join(target, ".env.example"), "utf-8");
        expect(env).toBe("CUSTOM_KEY=");

        // .env should be copied from the template's .env.example
        const dotEnv = await fs.readFile(path.join(target, ".env"), "utf-8");
        expect(dotEnv).toBe("CUSTOM_KEY=");
      });
    } finally {
      s.restore();
    }
  });

  test("copies subdirectories recursively", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");

        await runNew({
          targetDir: target,
          template: "advanced",
          templatesDir,
        });

        const helper = await fs.readFile(path.join(target, "tools", "helper.ts"), "utf-8");
        expect(helper).toBe("// helper");
      });
    } finally {
      s.restore();
    }
  });

  test("copies .env.example to .env from shared", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");

        // simple doesn't have its own .env.example, so shared one is used
        await runNew({
          targetDir: target,
          template: "simple",
          templatesDir,
        });

        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        const env = await fs.readFile(path.join(target, ".env"), "utf-8");
        expect(env).toBe("MY_KEY=");
      });
    } finally {
      s.restore();
    }
  });

  test("throws for unknown template", async () => {
    const s = silenceSteps();
    try {
      await withTempDir(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "output");

        await expect(
          runNew({
            targetDir: target,
            template: "nonexistent",
            templatesDir,
          }),
        ).rejects.toThrow("unknown template");
      });
    } finally {
      s.restore();
    }
  });
});
