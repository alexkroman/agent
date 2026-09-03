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
 *
 * **That makes this file a real-build outlier in the UNIT tier, and it needs a
 * timeout that says so.** Every case here spawns a Vite/rolldown pass — ~50ms on
 * a developer's machine, coverage instrumentation included, but the whole aai-cli
 * suite is CPU-bound and parallel, so on a two-core CI runner an individual build
 * can be starved well past the tier's 5s default. It failed exactly that way
 * (one case of eleven, the other ten passing in the same run), which makes it a
 * flake rather than a cost: the fix is a budget matching what these actually are,
 * not a faster test.
 *
 * It stays in the unit tier rather than moving to integration because
 * `worker-bundler.ts`'s coverage is measured here, and aai-cli's floors sit
 * 1.3-2.2 points above actuals — moving it means restoring that coverage first,
 * never lowering a floor. Same standing judgement as
 * `agent-server-integration.test.ts` in aai-server.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { linkSdkNodeModules, withTempDir } from "./_test-utils.ts";
import { buildWorker } from "./worker-bundler.ts";

/**
 * Per-case budget for a real bundler pass. The integration tier's number, because
 * that is what each of these is; see the module doc for why they live here anyway.
 */
const BUILD_TIMEOUT_MS = 30_000;

const AGENT = `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "T" });\n`;

const toolSource = (description: string) =>
  `import { tool } from "@alexkroman1/aai";\n` +
  `export default tool({ description: ${JSON.stringify(description)}, execute: () => 1 });\n`;

/** Build `dir` and evaluate the worker, returning its default export. */
async function loadWorker(
  dir: string,
): Promise<{ tools: Record<string, unknown>; systemPrompt: string }> {
  const code = await buildWorker(dir, { runtime: false });
  const out = path.join(dir, "worker.mjs");
  await fs.writeFile(out, code, "utf-8");
  const mod = (await import(pathToFileURL(out).href)) as {
    default: { tools: Record<string, unknown>; systemPrompt: string };
  };
  return mod.default;
}

describe("tool discovery", { timeout: BUILD_TIMEOUT_MS }, () => {
  test("a file in tools/ becomes a tool named for the file", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
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
      await linkSdkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");

      // The ENOENT path: a workflow app has no tools/, and a missing directory
      // is normal rather than a build failure.
      const agentDef = await loadWorker(dir);
      expect(agentDef.tools).toEqual({});
    });
  });

  test("a co-located spec in tools/ is not a tool", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
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

  test("a NESTED file fails the build, naming it, rather than being skipped", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.mkdir(path.join(dir, "tools", "billing"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "tools", "billing", "refund.ts"),
        toolSource("Refund"),
        "utf-8",
      );

      // "`tools/` is flat" was a documented rule that nothing enforced: a
      // one-level readdir skipped the subdirectory, so this project built an
      // agent with NO tools and no error — the silent absence discovery exists
      // to kill. Discovery is recursive now, and `toolRegistry` owns the
      // rejection, so the rule has one implementation rather than two.
      await expect(loadWorker(dir)).rejects.toThrow(/billing\/refund\.ts/);
    });
  });

  test("a file that does not default-export a tool fails the build, naming it", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
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

describe("system-prompt.md discovery", { timeout: BUILD_TIMEOUT_MS }, () => {
  const PROMPT = "You are a terse assistant.\n\n- One sentence.\n";

  test("the file becomes the agent's systemPrompt, with nothing in agent.ts", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

      const agentDef = await loadWorker(dir);
      expect(agentDef.systemPrompt).toBe(PROMPT);
    });
  });

  test("no file leaves the framework default in place", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");

      // Five templates deliberately run on DEFAULT_SYSTEM_PROMPT, so an absent
      // file is a normal shape rather than a build failure.
      const agentDef = await loadWorker(dir);
      expect(agentDef.systemPrompt).toContain("voice agent");
    });
  });

  test("a COMPOSED prompt keeps what the author built", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        `import { agent } from "@alexkroman1/aai";\n` +
          `import prompt from "./system-prompt.md?raw";\n` +
          `export default agent({ name: "T", systemPrompt: \`\${prompt}\\nTODAY: fish\` });\n`,
        "utf-8",
      );
      await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

      // `pizza-ordering`'s shape — the file plus a computed suffix. Discovery
      // must not apply the file a second time, and must not call this a mistake.
      const agentDef = await loadWorker(dir);
      expect(agentDef.systemPrompt).toBe(`${PROMPT}\nTODAY: fish`);
    });
  });

  test("a file nothing reads fails the build, rather than being ignored", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        `import { agent } from "@alexkroman1/aai";\n` +
          `export default agent({ name: "T", systemPrompt: "Inline, and not the file." });\n`,
        "utf-8",
      );
      await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

      // "I edited system-prompt.md and nothing changed" is the silent-absence
      // failure discovery exists to kill, pointing the other way.
      await expect(loadWorker(dir)).rejects.toThrow(/nothing reads it/);
    });
  });

  test("a system-prompt/ DIRECTORY is rejected, not ignored", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.mkdir(path.join(dir, "system-prompt"));
      await fs.writeFile(path.join(dir, "system-prompt", "intro.md"), PROMPT, "utf-8");

      // Declining a directory is the decision; declining it SILENTLY is not.
      // Before this was checked, the author got DEFAULT_SYSTEM_PROMPT with
      // nothing saying why their prompt had no effect.
      await expect(loadWorker(dir)).rejects.toThrow(/is a directory/);
    });
  });

  test("an empty file is an error, not a silent fall-through to the default", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
      await fs.writeFile(path.join(dir, "system-prompt.md"), "   \n\n", "utf-8");

      await expect(loadWorker(dir)).rejects.toThrow(/is empty/);
    });
  });
});
