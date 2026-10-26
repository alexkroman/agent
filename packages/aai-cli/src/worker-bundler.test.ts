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
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { describe, expect, vi } from "vitest";
import { linkSdkNodeModules, test } from "./_test-utils.ts";
import { buildWorker, discoverModuleFiles } from "./worker-bundler.ts";

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
): Promise<{ tools: Record<string, unknown>; systemPrompt: string; promptContext?: string }> {
  const code = await buildWorker(dir, { runtime: false });
  const out = path.join(dir, "worker.mjs");
  await fs.writeFile(out, code, "utf-8");
  const mod = (await import(pathToFileURL(out).href)) as {
    default: { tools: Record<string, unknown>; systemPrompt: string; promptContext?: string };
  };
  return mod.default;
}

describe("discoverModuleFiles (the directory read, before any build)", () => {
  test("both directories are read recursively, by the SDK's one file rule, sorted", async ({
    tmpDir: dir,
  }) => {
    // The failure this pins: `workflows/` was read FLAT, so a nested
    // `workflows/sub/x.ts` default-exporting a def was never handed to the
    // registry, whose "nested" refusal was dead code; and the extension rule
    // was this file's own, so it disagreed with `virtual:aai/agent`.
    for (const file of [
      "tools/echo.ts",
      "tools/page.tsx",
      "tools/alt.mts",
      "tools/sub/nested.ts",
      "tools/echo.test.ts",
      "tools/README.md",
      "workflows/digest.ts",
      "workflows/sub/x.ts",
      "workflows/lib/helper.mjs",
      "workflows/digest.test-d.ts",
      "workflows/notes.txt",
    ]) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), "export const x = 1;\n", "utf-8");
    }
    expect(await discoverModuleFiles(dir, "tools")).toEqual([
      "alt.mts",
      "echo.ts",
      "page.tsx",
      "sub/nested.ts",
    ]);
    expect(await discoverModuleFiles(dir, "workflows")).toEqual([
      "digest.ts",
      "lib/helper.mjs",
      "sub/x.ts",
    ]);
  });

  test("a missing directory is nothing to discover", async ({ tmpDir: dir }) => {
    expect(await discoverModuleFiles(dir, "workflows")).toEqual([]);
  });

  test("a FILE where the directory should be is refused naming it, not a raw ENOTDIR", async ({
    tmpDir: dir,
  }) => {
    await fs.writeFile(path.join(dir, "workflows"), "export default 1;\n", "utf-8");
    await expect(discoverModuleFiles(dir, "workflows")).rejects.toThrow(
      /workflows is a file, but `workflows\/` must be a DIRECTORY: one file per workflow/,
    );
  });
});

describe("tool discovery", { timeout: BUILD_TIMEOUT_MS }, () => {
  test("a file in tools/ becomes a tool named for the file", async ({ tmpDir: dir }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
    await fs.mkdir(path.join(dir, "tools"));
    await fs.writeFile(path.join(dir, "tools", "roll_dice.ts"), toolSource("Roll"), "utf-8");
    await fs.writeFile(path.join(dir, "tools", "read_menu.ts"), toolSource("Menu"), "utf-8");

    const agentDef = await loadWorker(dir);
    // Registered under the FILE name, with nothing in agent.ts saying so.
    expect(Object.keys(agentDef.tools).sort()).toEqual(["read_menu", "roll_dice"]);
  });

  test("a project with no tools/ directory builds and declares none", async ({ tmpDir: dir }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");

    // The ENOENT path: a workflow app has no tools/, and a missing directory
    // is normal rather than a build failure.
    const agentDef = await loadWorker(dir);
    expect(agentDef.tools).toEqual({});
  });

  test("a co-located spec in tools/ is not a tool", async ({ tmpDir: dir }) => {
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

  test("a NESTED file fails the build, naming it, rather than being skipped", async ({
    tmpDir: dir,
  }) => {
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

  test("a file that does not default-export a tool fails the build, naming it", async ({
    tmpDir: dir,
  }) => {
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

describe("workflow discovery", { timeout: BUILD_TIMEOUT_MS }, () => {
  const workflowSource = (description: string) =>
    `import { workflow } from "@alexkroman1/aai";\n` +
    `export default workflow({ description: ${JSON.stringify(description)}, run: async () => 1 });\n`;

  /** The built worker's workflow names and descriptions. */
  async function loadWorkflows(dir: string): Promise<Record<string, string | undefined>> {
    const code = await buildWorker(dir, { runtime: false });
    const out = path.join(dir, "worker.mjs");
    await fs.writeFile(out, code, "utf-8");
    const mod = (await import(pathToFileURL(out).href)) as {
      default: { workflows?: Record<string, { description?: string }> };
    };
    return Object.fromEntries(
      Object.entries(mod.default.workflows ?? {}).map(([name, def]) => [name, def.description]),
    );
  }

  test("a workflows/ file default-exporting a def is registered under the file name", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
    await fs.mkdir(path.join(dir, "workflows"));
    await fs.writeFile(path.join(dir, "workflows", "digest.ts"), workflowSource("Digest"), "utf-8");
    // A body's helper, and a spec: imported (the helper) or skipped (the spec),
    // registered neither way.
    await fs.writeFile(path.join(dir, "workflows", "prompts.ts"), "export const P = 1;\n", "utf-8");
    await fs.writeFile(
      path.join(dir, "workflows", "digest.test.ts"),
      "export default { nope: true };\n",
      "utf-8",
    );

    expect(await loadWorkflows(dir)).toEqual({ digest: "Digest" });
  });

  test("an explicit agent({ workflows }) entry wins a clash and the rest merge", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(
      path.join(dir, "agent.ts"),
      `import { agent, workflow } from "@alexkroman1/aai";\n` +
        `export default agent({ name: "T", workflows: { digest: workflow({ description: "Declared", run: async () => 1 }) } });\n`,
      "utf-8",
    );
    await fs.mkdir(path.join(dir, "workflows"));
    await fs.writeFile(path.join(dir, "workflows", "digest.ts"), workflowSource("File"), "utf-8");
    await fs.writeFile(path.join(dir, "workflows", "recap.ts"), workflowSource("Recap"), "utf-8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await loadWorkflows(dir)).toEqual({ digest: "Declared", recap: "Recap" });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/workflows\/digest\.ts/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("system-prompt.md discovery", { timeout: BUILD_TIMEOUT_MS }, () => {
  const PROMPT = "You are a terse assistant.\n\n- One sentence.\n";

  test("the file becomes the agent's systemPrompt, with nothing in agent.ts", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
    await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

    const agentDef = await loadWorker(dir);
    expect(agentDef.systemPrompt).toBe(PROMPT);
  });

  test("no file leaves the framework default in place", async ({ tmpDir: dir }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");

    // Five templates deliberately run on DEFAULT_SYSTEM_PROMPT, so an absent
    // file is a normal shape rather than a build failure.
    const agentDef = await loadWorker(dir);
    expect(agentDef.systemPrompt).toContain("voice agent");
  });

  test("computed text beside the file rides as promptContext, the file untouched", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(
      path.join(dir, "agent.ts"),
      `import { agent } from "@alexkroman1/aai";\n` +
        `export default agent({ name: "T", promptContext: "TODAY: fish" });\n`,
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

    // `pizza-ordering-agent`'s shape — the file plus a computed suffix, which is
    // `promptContext` now that `agent()` takes no prompt: the file is still
    // applied, and the context stays its own field for the builder to append.
    const agentDef = await loadWorker(dir);
    expect(agentDef.systemPrompt).toBe(PROMPT);
    expect(agentDef.promptContext).toBe("TODAY: fish");
  });

  test("a raw config's RESOLVER survives the build, and puts nothing on the wire", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    // A raw `export default {...}` is the one author-side place a prompt
    // resolver can still be written (`agent()` refuses the key); the host's
    // `withSystemPrompt` is the other.
    await fs.writeFile(
      path.join(dir, "agent.ts"),
      `import prompt from "./system-prompt.md?raw";\n` +
        'export default { name: "T", systemPrompt: (ctx) => `${prompt}\\nSession ${ctx.sessionId}.` };\n',
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

    // Discovery must not apply the file a second time and must not call the
    // function a mistake — it used to THROW here.
    const code = await buildWorker(dir, { runtime: false });
    const out = path.join(dir, "worker-resolver.mjs");
    await fs.writeFile(out, code, "utf-8");
    const mod = (await import(pathToFileURL(out).href)) as {
      default: { systemPrompt: (ctx: { sessionId: string }) => string };
      __aaiConfig: Record<string, unknown>;
    };

    expect(typeof mod.default.systemPrompt).toBe("function");
    expect(mod.default.systemPrompt({ sessionId: "s_1" })).toBe(`${PROMPT}\nSession s_1.`);
    // A function cannot be serialized, so `toAgentConfig` drops it and the
    // schema fills the framework default in its place — what a resolver adds
    // is APPENDED to that, by the runtime, which is the side that can call it.
    // What this pins against is a config carrying the resolver's SOURCE TEXT,
    // which nothing downstream rejects.
    expect(mod.__aaiConfig.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("a file nothing reads fails the build, rather than being ignored", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    // A raw config, since `agent({ systemPrompt })` is refused before the
    // file is ever compared.
    await fs.writeFile(
      path.join(dir, "agent.ts"),
      `export default { name: "T", systemPrompt: "Inline, and not the file." };\n`,
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "system-prompt.md"), PROMPT, "utf-8");

    // "I edited system-prompt.md and nothing changed" is the silent-absence
    // failure discovery exists to kill, pointing the other way.
    await expect(loadWorker(dir)).rejects.toThrow(/nothing reads it/);
  });

  test("a system-prompt/ DIRECTORY is rejected, not ignored", async ({ tmpDir: dir }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
    await fs.mkdir(path.join(dir, "system-prompt"));
    await fs.writeFile(path.join(dir, "system-prompt", "intro.md"), PROMPT, "utf-8");

    // Declining a directory is the decision; declining it SILENTLY is not.
    // Before this was checked, the author got DEFAULT_SYSTEM_PROMPT with
    // nothing saying why their prompt had no effect.
    await expect(loadWorker(dir)).rejects.toThrow(/is a directory/);
  });

  test("an empty file is an error, not a silent fall-through to the default", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
    await fs.writeFile(path.join(dir, "system-prompt.md"), "   \n\n", "utf-8");

    await expect(loadWorker(dir)).rejects.toThrow(/is empty/);
  });
});
