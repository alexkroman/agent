// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for the SDK internal API surface.
 *
 * Tests the connected flow: plain object agents → direct executor → KV.
 */

import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { toAgentConfig } from "../isolate/lib/internal-types.ts";
import type { AgentDef } from "../isolate/types.ts";
import { createRuntime } from "./direct-executor.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

describe("SDK integration: agent → tool execution", () => {
  test("plain object agent + executeToolCall round-trip", async () => {
    const agent: AgentDef = {
      name: "test-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {
        greet: {
          description: "Greet by name",
          parameters: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          execute: (args) => `Hello, ${args.name}!`,
        },
      },
    };

    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("greet", { name: "Alice" }, "s1", []);
    expect(result).toBe("Hello, Alice!");
  });

  test("tool with KV access works end-to-end", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    const agent: AgentDef = {
      name: "kv-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {
        save: {
          description: "Save a value",
          parameters: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
          execute: async (args, ctx) => {
            await ctx.kv.set(args.key as string, args.value);
            return "saved";
          },
        },
        load: {
          description: "Load a value",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          execute: async (args, ctx) => {
            const val = await ctx.kv.get<string>(args.key as string);
            return val ?? "not found";
          },
        },
      },
    };

    const exec = createRuntime({ agent, env: {}, kv });
    await exec.executeTool("save", { key: "color", value: "blue" }, "s1", []);
    const result = await exec.executeTool("load", { key: "color" }, "s1", []);
    expect(result).toBe("blue");
  });

  test("env vars are passed to tool context", async () => {
    const agent: AgentDef = {
      name: "env-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {
        check_key: {
          description: "Check API key",
          execute: (_args, ctx) => ctx.env.API_KEY ?? "missing",
        },
      },
    };

    const exec = createRuntime({ agent, env: { API_KEY: "sk-test-123" } });
    const result = await exec.executeTool("check_key", {}, "s1", []);
    expect(result).toBe("sk-test-123");
  });

  test("per-session state isolation", async () => {
    const agent: AgentDef = {
      name: "state-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
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
    };

    const exec = createRuntime({ agent, env: {} });
    expect(await exec.executeTool("increment", {}, "session-a", [])).toBe("1");
    expect(await exec.executeTool("increment", {}, "session-a", [])).toBe("2");
    expect(await exec.executeTool("increment", {}, "session-b", [])).toBe("1");
  });

  test("unknown tool returns error JSON", async () => {
    const agent: AgentDef = {
      name: "test",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {},
    };
    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("nonexistent", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ error: "Unknown tool: nonexistent" });
  });

  test("toAgentConfig produces serializable config", () => {
    const agent: AgentDef = {
      name: "config-test",
      systemPrompt: "Custom system prompt",
      greeting: "",
      builtinTools: ["web_search"],
      maxSteps: 10,
      toolChoice: "required",
      tools: {},
    };

    const config = toAgentConfig(agent);
    const parsed = JSON.parse(JSON.stringify(config));
    expect(parsed.name).toBe("config-test");
    expect(parsed.systemPrompt).toBe("Custom system prompt");
    expect(parsed.builtinTools).toEqual(["web_search"]);
    expect(parsed.maxSteps).toBe(10);
    expect(parsed.toolChoice).toBe("required");
  });

  test("lifecycle hooks fire correctly", async () => {
    const log: string[] = [];
    const agent: AgentDef = {
      name: "hooks-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {},
      onConnect: () => {
        log.push("connected");
      },
      onDisconnect: () => {
        log.push("disconnected");
      },
      onTurn: (text) => {
        log.push(`turn:${text}`);
      },
    };

    const exec = createRuntime({ agent, env: {} });
    await exec.hooks.callHook("connect", "s1");
    await exec.hooks.callHook("turn", "s1", "Hello world");
    await exec.hooks.callHook("disconnect", "s1");
    expect(log).toEqual(["connected", "turn:Hello world", "disconnected"]);
  });

  test("builtin tools are available alongside custom tools", async () => {
    const agent: AgentDef = {
      name: "mixed-tools",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom tool", execute: () => "custom result" },
      },
    };

    const exec = createRuntime({ agent, env: {} });
    expect(await exec.executeTool("custom", {}, "s1", [])).toBe("custom result");
    const codeResult = await exec.executeTool(
      "run_code",
      { code: 'console.log("from builtin")' },
      "s1",
      [],
    );
    expect(codeResult).toBe("from builtin");
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("messages are passed through to tool context", async () => {
    const agent: AgentDef = {
      name: "messages-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {
        count_msgs: {
          description: "Count messages",
          execute: (_args, ctx) => String(ctx.messages.length),
        },
      },
    };

    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("count_msgs", {}, "s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result).toBe("2");
  });
});
