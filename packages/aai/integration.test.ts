// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for the SDK public API surface.
 *
 * These test the connected flow as a consumer would use it:
 * defineAgent → tools → direct executor → KV in tool context.
 */

import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "./_internal-types.ts";
import { createRuntime } from "./direct-executor.ts";
import { defineAgent, defineTool } from "./types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

describe("SDK integration: defineAgent → tool execution", () => {
  test("defineAgent + defineTool() + executeToolCall round-trip", async () => {
    const agent = defineAgent({
      name: "test-agent",
      tools: {
        greet: defineTool({
          description: "Greet by name",
          parameters: z.object({ name: z.string() }),
          execute: ({ name }) => `Hello, ${name}!`,
        }),
      },
    });

    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("greet", { name: "Alice" }, "s1", []);
    expect(result).toBe("Hello, Alice!");
  });

  test("tool with KV access works end-to-end", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    const agent = defineAgent({
      name: "kv-agent",
      tools: {
        save: defineTool({
          description: "Save a value",
          parameters: z.object({ key: z.string(), value: z.string() }),
          execute: async ({ key, value }, ctx) => {
            await ctx.kv.set(key, value);
            return "saved";
          },
        }),
        load: defineTool({
          description: "Load a value",
          parameters: z.object({ key: z.string() }),
          execute: async ({ key }, ctx) => {
            const val = await ctx.kv.get<string>(key);
            return val ?? "not found";
          },
        }),
      },
    });

    const exec = createRuntime({ agent, env: {}, kv });
    await exec.executeTool("save", { key: "color", value: "blue" }, "s1", []);
    const result = await exec.executeTool("load", { key: "color" }, "s1", []);
    expect(result).toBe("blue");
  });

  test("env vars are passed to tool context", async () => {
    const agent = defineAgent({
      name: "env-agent",
      tools: {
        check_key: {
          description: "Check API key",
          execute: (_args, ctx) => ctx.env.API_KEY ?? "missing",
        },
      },
    });

    const exec = createRuntime({ agent, env: { API_KEY: "sk-test-123" } });
    const result = await exec.executeTool("check_key", {}, "s1", []);
    expect(result).toBe("sk-test-123");
  });

  test("per-session state isolation", async () => {
    const agent = defineAgent({
      name: "state-agent",
      state: () => ({ count: 0 }),
      tools: {
        increment: {
          description: "Increment counter",
          execute: (_args, ctx) => {
            const s = ctx.state as { count: number };
            s.count += 1;
            return String(s.count);
          },
        },
      },
    });

    const exec = createRuntime({ agent, env: {} });
    expect(await exec.executeTool("increment", {}, "session-a", [])).toBe("1");
    expect(await exec.executeTool("increment", {}, "session-a", [])).toBe("2");
    // Different session starts fresh
    expect(await exec.executeTool("increment", {}, "session-b", [])).toBe("1");
  });

  test("unknown tool returns error JSON", async () => {
    const agent = defineAgent({ name: "test", tools: {} });
    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("nonexistent", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ error: "Unknown tool: nonexistent" });
  });

  test("tool parameter validation rejects bad input", async () => {
    const agent = defineAgent({
      name: "validation-agent",
      tools: {
        typed: defineTool({
          description: "Typed tool",
          parameters: z.object({ count: z.number() }),
          execute: ({ count }) => String(count * 2),
        }),
      },
    });

    const exec = createRuntime({ agent, env: {} });
    // Valid input
    expect(await exec.executeTool("typed", { count: 5 }, "s1", [])).toBe("10");
    // Invalid input
    const err = await exec.executeTool("typed", { count: "not a number" }, "s1", []);
    expect(err).toContain("error");
  });

  test("toAgentConfig produces serializable config", () => {
    const agent = defineAgent({
      name: "config-test",
      instructions: "Custom instructions",
      builtinTools: ["web_search"],
      maxSteps: 10,
      toolChoice: "required",
    });

    const config = toAgentConfig(agent);
    // Should survive JSON round-trip
    const parsed = JSON.parse(JSON.stringify(config));
    expect(parsed.name).toBe("config-test");
    expect(parsed.instructions).toBe("Custom instructions");
    expect(parsed.builtinTools).toEqual(["web_search"]);
    expect(parsed.maxSteps).toBe(10);
    expect(parsed.toolChoice).toBe("required");
  });

  test("lifecycle hooks fire correctly", async () => {
    const log: string[] = [];
    const agent = defineAgent({
      name: "hooks-agent",
      onConnect: () => {
        log.push("connected");
      },
      onDisconnect: () => {
        log.push("disconnected");
      },
      onTurn: (text) => {
        log.push(`turn:${text}`);
      },
    });

    const exec = createRuntime({ agent, env: {} });
    await exec.hookInvoker.onConnect("s1");
    await exec.hookInvoker.onTurn("s1", "Hello world");
    await exec.hookInvoker.onDisconnect("s1");
    expect(log).toEqual(["connected", "turn:Hello world", "disconnected"]);
  });

  test("builtin tools are available alongside custom tools", async () => {
    const agent = defineAgent({
      name: "mixed-tools",
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom tool", execute: () => "custom result" },
      },
    });

    const exec = createRuntime({ agent, env: {} });
    // Custom tool works
    expect(await exec.executeTool("custom", {}, "s1", [])).toBe("custom result");
    // Builtin tool works
    const codeResult = await exec.executeTool(
      "run_code",
      { code: 'console.log("from builtin")' },
      "s1",
      [],
    );
    expect(codeResult).toBe("from builtin");
    // Tool schemas include both
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("messages are passed through to tool context", async () => {
    const agent = defineAgent({
      name: "messages-agent",
      tools: {
        count_msgs: {
          description: "Count messages",
          execute: (_args, ctx) => String(ctx.messages.length),
        },
      },
    });

    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("count_msgs", {}, "s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result).toBe("2");
  });
});
