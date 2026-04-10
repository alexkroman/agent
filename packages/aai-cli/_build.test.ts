// Copyright 2025 the AAI authors. MIT license.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, runBuildCommand } from "./_bundler.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent.json found", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow(
        "Missing agent.json",
      );
    });
  });

  test("bundles minimal agent (no tools.ts)", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.json"),
          JSON.stringify({
            name: "build-test-agent",
            systemPrompt: "Test prompt",
            greeting: "Hello",
            maxSteps: 5,
            toolSchemas: [],
          }),
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig).toEqual({
          name: "build-test-agent",
          systemPrompt: "Test prompt",
          greeting: "Hello",
          maxSteps: 5,
          toolSchemas: [],
        });
        expect(bundle.worker).toContain("export");
        expect(bundle.clientFiles).toEqual({});
      }),
    );
  });

  test("bundles agent with tools.ts", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await mkdir(path.join(dir, "tools"), { recursive: true });
        await writeFile(
          path.join(dir, "tools", "greet.ts"),
          'export default async function(args: { name: string }) { return "Hello, " + args.name; }',
        );
        await writeFile(
          path.join(dir, "tools.ts"),
          'import greet from "./tools/greet.ts";\nexport const tools = { greet };\nexport const hooks = {};',
        );
        await writeFile(
          path.join(dir, "agent.json"),
          JSON.stringify({
            name: "tool-test-agent",
            systemPrompt: "Test",
            toolSchemas: [
              {
                name: "greet",
                description: "Say hello",
                parameters: { type: "object", properties: { name: { type: "string" } } },
              },
            ],
          }),
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig.name).toBe("tool-test-agent");
        expect(bundle.worker).toContain("greet");
        expect(bundle.worker.length).toBeGreaterThan(50);
      }),
    );
  });

  test("Vite-bundled worker is valid ESM with tools export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await mkdir(path.join(dir, "tools"), { recursive: true });
        await writeFile(
          path.join(dir, "tools", "echo.ts"),
          "export default async function(args: { msg: string }) { return args.msg; }",
        );
        await writeFile(
          path.join(dir, "tools.ts"),
          'import echo from "./tools/echo.ts";\nexport const tools = { echo };',
        );
        await writeFile(
          path.join(dir, "agent.json"),
          JSON.stringify({ name: "vite-test", systemPrompt: "Test" }),
        );
        const bundle = await buildAgentBundle(dir);
        // Worker must be valid ESM — check for export syntax
        expect(bundle.worker).toMatch(/export/);
        // Must contain the tool name
        expect(bundle.worker).toContain("echo");
        // Must be a non-trivial bundle
        expect(bundle.worker.length).toBeGreaterThan(20);
      }),
    );
  });
});

describe("runBuildCommand", () => {
  test("throws when no agent.json found", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => runBuildCommand(dir))(dir)).rejects.toThrow("Missing agent.json");
    });
  });
});
