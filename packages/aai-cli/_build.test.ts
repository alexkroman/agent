// Copyright 2025 the AAI authors. MIT license.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, runBuildCommand } from "./_bundler.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

describe("buildAgentBundle", () => {
  test("throws when no agent.ts found in directory", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow("Missing agent.ts");
    });
  });

  test("bundles minimal agent directory", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default {
  name: "build-test-agent",
  systemPrompt: "Test prompt",
  greeting: "Hello",
  maxSteps: 5,
  tools: {},
};`,
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig.name).toBe("build-test-agent");
        expect(bundle.agentConfig.systemPrompt).toBe("Test prompt");
        expect(bundle.agentConfig.greeting).toBe("Hello");
        expect(bundle.agentConfig.maxSteps).toBe(5);
        expect(bundle.agentConfig.toolSchemas).toEqual([]);
        expect(bundle.agentConfig.hooks.onConnect).toBe(false);
        expect(bundle.worker).toBeTruthy();
        expect(bundle.worker.length).toBeGreaterThan(0);
        expect(bundle.clientFiles).toEqual({});
      }),
    );
  });

  test("bundles agent with tools", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await mkdir(path.join(dir, "tools"), { recursive: true });
        await writeFile(
          path.join(dir, "tools", "greet.ts"),
          `export default async function(args: { name: string }) {
  return "Hello, " + args.name;
}`,
        );
        await writeFile(
          path.join(dir, "agent.ts"),
          `import greet from "./tools/greet.ts";
export default {
  name: "tool-test-agent",
  systemPrompt: "Test",
  tools: {
    greet: {
      description: "Say hello",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      execute: greet,
    },
  },
};`,
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig.name).toBe("tool-test-agent");
        expect(bundle.agentConfig.toolSchemas).toHaveLength(1);
        expect(bundle.agentConfig.toolSchemas[0]).toEqual({
          name: "greet",
          description: "Say hello",
          parameters: { type: "object", properties: { name: { type: "string" } } },
        });
        expect(bundle.worker).toBeTruthy();
      }),
    );
  });

  test("detects hooks from agent default export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default {
  name: "hook-test-agent",
  systemPrompt: "Test",
  tools: {},
  onConnect: async (ctx: any) => {},
  onDisconnect: async (ctx: any) => {},
};`,
        );
        const bundle = await buildAgentBundle(dir);
        expect(bundle.agentConfig.hooks.onConnect).toBe(true);
        expect(bundle.agentConfig.hooks.onDisconnect).toBe(true);
        expect(bundle.agentConfig.hooks.onError).toBe(false);
        expect(bundle.agentConfig.hooks.onUserTranscript).toBe(false);
      }),
    );
  });
});

describe("runBuildCommand", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await expect(silenced(() => runBuildCommand(dir))(dir)).rejects.toThrow("Missing agent.ts");
    });
  });
});
