// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { makeAgent } from "./_test-utils.ts";
import { buildAgentConfig, createDirectExecutor } from "./direct-executor.ts";
import { createMemoryKv } from "./kv.ts";
import { tool } from "./types.ts";

describe("buildAgentConfig", () => {
  test("maps name, instructions, greeting from AgentDef", () => {
    const config = buildAgentConfig(makeAgent());
    expect(config.name).toBe("test-agent");
    expect(config.instructions).toBe("Be helpful.");
    expect(config.greeting).toBe("Hello!");
  });

  test("includes sttPrompt when defined", () => {
    const config = buildAgentConfig(makeAgent({ sttPrompt: "transcription hint" }));
    expect(config.sttPrompt).toBe("transcription hint");
  });

  test("omits sttPrompt when undefined", () => {
    const config = buildAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("sttPrompt");
  });

  test("includes static maxSteps", () => {
    const config = buildAgentConfig(makeAgent({ maxSteps: 10 }));
    expect(config.maxSteps).toBe(10);
  });

  test("excludes function maxSteps", () => {
    const config = buildAgentConfig(makeAgent({ maxSteps: () => 10 }));
    expect(config).not.toHaveProperty("maxSteps");
  });

  test("includes toolChoice when defined", () => {
    const config = buildAgentConfig(makeAgent({ toolChoice: "required" }));
    expect(config.toolChoice).toBe("required");
  });

  test("omits toolChoice when undefined", () => {
    const config = buildAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("toolChoice");
  });

  test("includes builtinTools when defined", () => {
    const config = buildAgentConfig(makeAgent({ builtinTools: ["web_search", "run_code"] }));
    expect(config.builtinTools).toEqual(["web_search", "run_code"]);
  });

  test("includes activeTools when defined", () => {
    const config = buildAgentConfig(makeAgent({ activeTools: ["toolA", "toolB"] }));
    expect(config.activeTools).toEqual(["toolA", "toolB"]);
  });
});

describe("createDirectExecutor", () => {
  test("executeTool returns error for unknown tool", async () => {
    const exec = createDirectExecutor({ agent: makeAgent(), env: {} });
    const result = await exec.executeTool("nonexistent", {}, "session-1", []);
    expect(result).toBe(JSON.stringify({ error: "Unknown tool: nonexistent" }));
  });

  test("hookInvoker.onConnect can be called without error", async () => {
    const exec = createDirectExecutor({ agent: makeAgent(), env: {} });
    await expect(exec.hookInvoker.onConnect("session-1")).resolves.toBeUndefined();
  });

  test("executeTool with a real tool returns result", async () => {
    const agent = makeAgent({
      tools: {
        add: tool({
          description: "Add two numbers",
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => String(a + b),
        }),
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    expect(await exec.executeTool("add", { a: 3, b: 4 }, "s1", [])).toBe("7");
  });

  test("executeTool passes KV to tool context", async () => {
    const kv = createMemoryKv();
    await kv.set("key1", "value1");
    const agent = makeAgent({
      tools: {
        read_kv: {
          description: "Read from KV",
          execute: async (_args, ctx) => (await ctx.kv.get<string>("key1")) ?? "missing",
        },
      },
    });
    const exec = createDirectExecutor({ agent, env: {}, kv });
    expect(await exec.executeTool("read_kv", {}, "s1", [])).toBe("value1");
  });

  test("toolSchemas includes both custom and builtin tools", () => {
    const agent = makeAgent({
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom", execute: () => "ok" },
      },
    });
    const exec = createDirectExecutor({ agent, env: {} });
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("resolveTurnConfig returns null when no dynamic config", async () => {
    const exec = createDirectExecutor({ agent: makeAgent(), env: {} });
    expect(await exec.hookInvoker.resolveTurnConfig("s1")).toBe(null);
  });

  test("resolveTurnConfig resolves dynamic maxSteps", async () => {
    const agent = makeAgent({ maxSteps: () => 15 });
    const exec = createDirectExecutor({ agent, env: {} });
    const config = await exec.hookInvoker.resolveTurnConfig("s1");
    expect(config?.maxSteps).toBe(15);
  });
});
