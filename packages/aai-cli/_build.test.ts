// Copyright 2025 the AAI authors. MIT license.
import { readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, evalWorkerBundle, executeBuild } from "./_bundler.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow("agent.ts");
    });
  });

  test("bundles minimal agent (no tools)", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "build-test-agent", systemPrompt: "Test prompt", greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig.name).toBe("build-test-agent");
        expect(bundle.agentConfig.systemPrompt).toBe("Test prompt");
        expect(bundle.agentConfig.greeting).toBe("Hello");
        expect(bundle.agentConfig.maxSteps).toBe(5);
        expect(bundle.agentConfig.toolSchemas).toEqual([]);
        expect(bundle.worker).toContain("export");
        expect(bundle.clientFiles).toEqual({});
      }),
    );
  });

  test("bundles agent with tools and extracts schemas", async () => {
    await withTempDir(
      silenced(async (dir) => {
        // Symlink node_modules so Vite can resolve zod when bundling
        await symlink(
          path.resolve(import.meta.dirname, "node_modules"),
          path.join(dir, "node_modules"),
        );
        await writeFile(
          path.join(dir, "agent.ts"),
          `
import { z } from "zod";

const greetTool = {
  description: "Greet someone by name",
  parameters: z.object({ name: z.string() }),
  execute: ({ name }) => "Hello, " + name,
};

export default {
  name: "tool-test-agent",
  systemPrompt: "Test",
  greeting: "Hi",
  maxSteps: 5,
  tools: { greet: greetTool },
};
`,
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig.name).toBe("tool-test-agent");
        expect(bundle.agentConfig.toolSchemas).toEqual([
          {
            type: "function",
            name: "greet",
            description: "Greet someone by name",
            parameters: expect.objectContaining({ type: "object" }),
          },
        ]);
        // Worker should contain the tool code
        expect(bundle.worker).toContain("greet");
        expect(bundle.worker.length).toBeGreaterThan(50);
      }),
    );
  });

  test("minify option produces a smaller worker that still evaluates", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.ts"),
          `const longDescriptiveVariableName = "Test prompt";
export default { name: "minify-test-agent", systemPrompt: longDescriptiveVariableName, greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const plain = await buildAgentBundle(dir);
        const minified = await buildAgentBundle(dir, { minify: true });
        // Minified bundle still evaluates to the same agent config.
        expect(minified.agentConfig.name).toBe("minify-test-agent");
        expect(minified.agentConfig.systemPrompt).toBe("Test prompt");
        // And it is no larger than the unminified build.
        expect(minified.worker.length).toBeLessThanOrEqual(plain.worker.length);
      }),
    );
  });

  test("Vite-bundled worker is valid ESM with default export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "vite-test", systemPrompt: "Test", greeting: "Hi", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir);
        // Worker must be valid ESM — check for export syntax
        expect(bundle.worker).toMatch(/export/);
        // Must be a non-trivial bundle
        expect(bundle.worker.length).toBeGreaterThan(20);
      }),
    );
  });
});

describe("executeBuild", () => {
  test("returns the agent name and worker size", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "exec-build", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );
        const result = await executeBuild(dir);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.name).toBe("exec-build");
          expect(result.data.workerBytes).toBeGreaterThan(20);
        }
      }),
    );
  });
});

describe("evalWorkerBundle", () => {
  test("explains an unwritable eval dir instead of a raw fs error", async () => {
    await withTempDir(async (dir) => {
      // `.aai` exists as a *file*, so mkdir(.aai/eval) fails — the error must
      // say what the CLI was doing, not just surface ENOTDIR.
      await writeFile(path.join(dir, ".aai"), "not a directory");
      await expect(evalWorkerBundle("export default {}", dir)).rejects.toThrow(
        /Failed to write the eval bundle/,
      );
    });
  });

  test("evaluates a worker bundle and cleans up the temp file", async () => {
    await withTempDir(async (dir) => {
      const agent = await evalWorkerBundle(
        `export default { name: "evaled", systemPrompt: "p", greeting: "g", tools: {} };`,
        dir,
      );
      expect(agent.name).toBe("evaled");
      const evalDir = path.join(dir, ".aai", "eval");
      const leftovers = await readdir(evalDir);
      expect(leftovers).toEqual([]);
    });
  });
});
