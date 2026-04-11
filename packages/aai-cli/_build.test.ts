// Copyright 2025 the AAI authors. MIT license.
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, runBuildCommand } from "./_bundler.ts";
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

describe("runBuildCommand", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => runBuildCommand(dir))(dir)).rejects.toThrow("agent.ts");
    });
  });
});
