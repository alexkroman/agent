// Copyright 2025 the AAI authors. MIT license.
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, evalWorkerBundle, executeBuild } from "./_bundler.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

/**
 * Symlink this package's node_modules into the fixture project so the
 * worker wrapper's `@alexkroman1/aai/manifest` import (and any fixture
 * import of `zod`) resolves — a real project has the SDK installed.
 */
async function linkNodeModules(dir: string): Promise<void> {
  await symlink(path.resolve(import.meta.dirname, "node_modules"), path.join(dir, "node_modules"));
}

/** Import a built worker and return its `__aaiConfig` self-description. */
async function extractConfig(worker: string): Promise<Record<string, unknown>> {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(worker).toString("base64")}`);
  return mod.__aaiConfig as Record<string, unknown>;
}

describe("buildAgentBundle", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow("agent.ts");
    });
  });

  test("bundles minimal agent with a self-describing config export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "build-test-agent", systemPrompt: "Test prompt", greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir);
        const config = await extractConfig(bundle.worker);
        expect(config.name).toBe("build-test-agent");
        expect(config.systemPrompt).toBe("Test prompt");
        expect(config.greeting).toBe("Hello");
        expect(config.maxSteps).toBe(5);
        expect(config.toolSchemas).toEqual([]);
        expect(bundle.worker).toContain("export");
        expect(bundle.clientFiles).toEqual({});
      }),
    );
  });

  test("bundles agent with tools and self-describes their schemas", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkNodeModules(dir);
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
        const config = await extractConfig(bundle.worker);
        expect(config.name).toBe("tool-test-agent");
        expect(config.toolSchemas).toEqual([
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
        await linkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `const longDescriptiveVariableName = "Test prompt";
export default { name: "minify-test-agent", systemPrompt: longDescriptiveVariableName, greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const plain = await buildAgentBundle(dir);
        const minified = await buildAgentBundle(dir, { minify: true });
        // Minified bundle still evaluates to the same agent config.
        const config = await extractConfig(minified.worker);
        expect(config.name).toBe("minify-test-agent");
        expect(config.systemPrompt).toBe("Test prompt");
        // And it is no larger than the unminified build.
        expect(minified.worker.length).toBeLessThanOrEqual(plain.worker.length);
      }),
    );
  });

  test("Vite-bundled worker is valid ESM with default export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkNodeModules(dir);
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
        await linkNodeModules(dir);
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
  test("evaluates a worker bundle without touching the filesystem", async () => {
    const agent = await evalWorkerBundle(
      `export default { name: "evaled", systemPrompt: "p", greeting: "g", tools: {} };`,
    );
    expect(agent.name).toBe("evaled");
  });
});
