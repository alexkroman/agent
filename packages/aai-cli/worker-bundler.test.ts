// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool discovery, which is the one thing the generated worker entry does that
 * `agent.ts` cannot do for itself.
 *
 * A tool is registered by EXISTING under `tools/`, and the lowering that makes
 * that work has to happen here: the guest sandbox is handed one ESM string and
 * has no directory to scan, so the entry enumerates the directory at build time
 * and emits static imports the bundler follows. These specs drive the real Vite
 * pass rather than asserting on the entry's source text, because the property
 * that matters is that the built worker's default export CARRIES the tools —
 * source text can look right and resolve to nothing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { buildWorker } from "./worker-bundler.ts";

/** The built worker resolves `@alexkroman1/aai` out of this package's tree. */
async function linkNodeModules(dir: string): Promise<void> {
  await fs.symlink(
    path.resolve(import.meta.dirname, "node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
}

const AGENT = `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "T" });\n`;

const toolSource = (description: string) =>
  `import { tool } from "@alexkroman1/aai";\n` +
  `export default tool({ description: ${JSON.stringify(description)}, execute: () => 1 });\n`;

/** Build `dir` and evaluate the worker, returning its default export. */
async function loadWorker(dir: string): Promise<{ tools: Record<string, unknown> }> {
  const code = await buildWorker(dir, { runtime: false });
  const out = path.join(dir, "worker.mjs");
  await fs.writeFile(out, code, "utf-8");
  const mod = (await import(pathToFileURL(out).href)) as {
    default: { tools: Record<string, unknown> };
  };
  return mod.default;
}

describe("tool discovery", () => {
  test("a file in tools/ becomes a tool named for the file", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(path.join(dir, "tools", "roll_dice.ts"), toolSource("Roll"), "utf-8");
      await fs.writeFile(path.join(dir, "tools", "read_menu.ts"), toolSource("Menu"), "utf-8");

      const agentDef = await loadWorker(dir);
      // Registered under the FILE name, with nothing in agent.ts saying so.
      expect(Object.keys(agentDef.tools).sort()).toEqual(["read_menu", "roll_dice"]);
    });
  });

  test("a project with no tools/ directory builds and declares none", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");

      // The ENOENT path: a workflow app has no tools/, and a missing directory
      // is normal rather than a build failure.
      const agentDef = await loadWorker(dir);
      expect(agentDef.tools).toEqual({});
    });
  });

  test("a co-located spec in tools/ is not a tool", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(path.join(dir, "tools", "roll_dice.ts"), toolSource("Roll"), "utf-8");
      // Would otherwise register as `roll_dice.test`, and would be bundled.
      await fs.writeFile(
        path.join(dir, "tools", "roll_dice.test.ts"),
        "export default { nope: true };\n",
        "utf-8",
      );

      const agentDef = await loadWorker(dir);
      expect(Object.keys(agentDef.tools)).toEqual(["roll_dice"]);
    });
  });

  test("a file that does not default-export a tool fails the build, naming it", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(
        path.join(dir, "tools", "broken.ts"),
        `export const notDefault = 1;\nexport default { description: "no execute" };\n`,
        "utf-8",
      );

      // The whole point of discovery: this class of mistake is named at build
      // time instead of becoming a tool that fails on every turn.
      await expect(loadWorker(dir)).rejects.toThrow(/broken\.ts/);
    });
  });
});
