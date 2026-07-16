// Copyright 2025 the AAI authors. MIT license.
// Runtime config mapping and tool execution: toAgentConfig, createRuntime
// tool plumbing (including sandbox mode), and executeToolCall. Session
// lifecycle/routing specs live in runtime-lifecycle.test.ts.

import { createStorage } from "unstorage";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "../sdk/_internal-types.ts";
import type { ToolDef } from "../sdk/types.ts";
import { CONFORMANCE_AGENT, testRuntime } from "./_runtime-conformance.ts";
import { makeAgent } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { executeToolCall } from "./tool-executor.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("toAgentConfig", () => {
  test("maps name, systemPrompt, greeting from AgentDef", () => {
    const config = toAgentConfig(makeAgent());
    expect(config.name).toBe("test-agent");
    expect(config.systemPrompt).toBe("Be helpful.");
    expect(config.greeting).toBe("Hello!");
  });

  test("includes sttPrompt when defined", () => {
    const config = toAgentConfig(makeAgent({ sttPrompt: "transcription hint" }));
    expect(config.sttPrompt).toBe("transcription hint");
  });

  test("omits sttPrompt when undefined", () => {
    const config = toAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("sttPrompt");
  });

  test("includes static maxSteps", () => {
    const config = toAgentConfig(makeAgent({ maxSteps: 10 }));
    expect(config.maxSteps).toBe(10);
  });

  test("includes toolChoice when defined", () => {
    const config = toAgentConfig(makeAgent({ toolChoice: "required" }));
    expect(config.toolChoice).toBe("required");
  });

  test("omits toolChoice when undefined", () => {
    const config = toAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("toolChoice");
  });

  test("includes builtinTools when defined", () => {
    const config = toAgentConfig(makeAgent({ builtinTools: ["web_search", "run_code"] }));
    expect(config.builtinTools).toEqual(["web_search", "run_code"]);
  });
});

describe("createRuntime", () => {
  test("executeTool returns error for unknown tool", async () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    const result = await exec.executeTool("nonexistent", {}, "session-1", []);
    expect(result).toBe(JSON.stringify({ error: "Unknown tool: nonexistent" }));
  });

  test("executeTool with a real tool returns result", async () => {
    const agent = makeAgent({
      tools: {
        add: {
          description: "Add two numbers",
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }: { a: number; b: number }) => String(a + b),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    expect(await exec.executeTool("add", { a: 3, b: 4 }, "s1", [])).toBe("7");
  });

  test("executeTool passes KV to tool context", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    await kv.set("key1", "value1");
    const agent = makeAgent({
      tools: {
        read_kv: {
          description: "Read from KV",
          execute: async (_args, ctx) => (await ctx.kv.get<string>("key1")) ?? "missing",
        },
      },
    });
    const exec = createRuntime({ agent, env: {}, kv });
    expect(await exec.executeTool("read_kv", {}, "s1", [])).toBe("value1");
  });

  test("toolSchemas includes both custom and builtin tools", () => {
    const agent = makeAgent({
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom", execute: () => "ok" },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("session state is initialized from agent.state factory", async () => {
    const agent = makeAgent({
      state: () => ({ counter: 0 }),
      tools: {
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(ctx.state),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ counter: 0 });
  });

  test("executeTool passes messages to tool context", async () => {
    const agent = makeAgent({
      tools: {
        echo_messages: {
          description: "Echo messages",
          execute: (_args, ctx) => JSON.stringify(ctx.messages),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    const msgs = [{ role: "user" as const, content: "hi" }];
    const result = await exec.executeTool("echo_messages", {}, "s1", msgs);
    expect(JSON.parse(result)).toEqual(msgs);
  });

  test("sandbox mode forwards callOpts (toolCallId) to the RPC executor", async () => {
    // Regression: the RPC wrapper previously dropped the 5th `callOpts` arg, so
    // relayed tool calls reached the client without a toolCallId and failed with
    // "invoked without a toolCallId" in pipeline mode.
    const rpcExecuteTool = vi.fn(async () => "ok");
    const exec = createRuntime({
      agent: makeAgent({ tools: {} }),
      env: {},
      executeTool: rpcExecuteTool,
      toolSchemas: [
        {
          type: "function" as const,
          name: "find_user",
          description: "Find a user",
          parameters: { type: "object" },
        },
      ],
    });

    const result = await exec.executeTool("find_user", {}, "s1", [], { toolCallId: "toolu_123" });

    expect(result).toBe("ok");
    expect(rpcExecuteTool).toHaveBeenCalledWith("find_user", {}, "s1", [], {
      toolCallId: "toolu_123",
    });
  });

  test("env is frozen and passed to tools", async () => {
    const agent = makeAgent({
      tools: {
        get_env: {
          description: "Get env",
          execute: (_args, ctx) => ctx.env.MY_VAR ?? "missing",
        },
      },
    });
    const exec = createRuntime({ agent, env: { MY_VAR: "hello" } });
    const result = await exec.executeTool("get_env", {}, "s1", []);
    expect(result).toBe("hello");
  });

  test("readyConfig is present with audio format", () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    expect(exec.readyConfig).toEqual(
      expect.objectContaining({ audioFormat: "pcm16", sampleRate: expect.any(Number) }),
    );
  });

  test("shutdown resolves immediately when no sessions exist", async () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    await expect(exec.shutdown()).resolves.toBeUndefined();
  });

  test("startSession is a function", () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    expect(typeof exec.startSession).toBe("function");
  });
});

describe("executeToolCall", () => {
  test("returns 'null' when tool execute returns null", async () => {
    const tool: ToolDef = {
      description: "Returns null",
      execute: () => null as unknown as string,
    };
    const result = await executeToolCall("nullTool", {}, { tool, env: {} });
    expect(result).toBe("null");
  });

  test("returns 'null' when tool execute returns undefined", async () => {
    const tool: ToolDef = {
      description: "Returns undefined",
      execute: () => undefined as unknown as string,
    };
    const result = await executeToolCall("undefinedTool", {}, { tool, env: {} });
    expect(result).toBe("null");
  });

  test("JSON.stringifies non-string results", async () => {
    const tool: ToolDef = {
      description: "Returns object",
      execute: () => ({ count: 42 }) as unknown as string,
    };
    const result = await executeToolCall("objTool", {}, { tool, env: {} });
    expect(result).toBe(JSON.stringify({ count: 42 }));
  });

  test("JSON.stringifies numeric results", async () => {
    const tool: ToolDef = {
      description: "Returns number",
      execute: () => 123 as unknown as string,
    };
    const result = await executeToolCall("numTool", {}, { tool, env: {} });
    expect(result).toBe("123");
  });

  test("returns validation error for invalid args", async () => {
    const tool: ToolDef = {
      description: "Requires number",
      parameters: z.object({ n: z.number() }),
      execute: ({ n }: { n: number }) => String(n),
    };
    const result = await executeToolCall("typedTool", { n: "not-a-number" }, { tool, env: {} });
    expect(result).toContain("error");
    expect(result).toContain("Invalid arguments");
    expect(result).toContain("typedTool");
  });

  test("returns validation error with path info for nested args", async () => {
    const tool: ToolDef = {
      description: "Requires nested object",
      parameters: z.object({ config: z.object({ port: z.number() }) }),
      execute: () => "ok",
    };
    const result = await executeToolCall(
      "nestedTool",
      { config: { port: "abc" } },
      { tool, env: {} },
    );
    expect(result).toContain("config.port");
  });

  test("logs error with logger when tool throws", async () => {
    const tool: ToolDef = {
      description: "Throws error",
      execute: () => {
        throw new Error("boom");
      },
    };
    const logger = makeLogger();
    const result = await executeToolCall("failTool", {}, { tool, env: {}, logger });
    expect(result).toContain("error");
    expect(result).toContain("boom");
    expect(logger.warn).toHaveBeenCalledWith(
      "Tool execution failed",
      expect.objectContaining({ tool: "failTool" }),
    );
  });

  test("logs to console.warn when no logger provided", async () => {
    const tool: ToolDef = {
      description: "Throws error",
      execute: () => {
        throw new Error("no-logger-boom");
      },
    };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await executeToolCall("failTool", {}, { tool, env: {} });
      expect(result).toContain("error");
      expect(result).toContain("no-logger-boom");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[tool-executor] Tool execution failed: failTool"),
        expect.any(Error),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws KV not available when kv is not provided and tool accesses it", async () => {
    const tool: ToolDef = {
      description: "Access KV",
      execute: async (_args, ctx) => {
        await ctx.kv.get("key");
        return "ok";
      },
    };
    const logger = makeLogger();
    const result = await executeToolCall("kvTool", {}, { tool, env: {}, logger });
    expect(result).toContain("error");
    expect(result).toContain("KV not available");
  });

  test("uses default empty state when state not provided", async () => {
    const tool: ToolDef = {
      description: "Get state",
      execute: (_args, ctx) => JSON.stringify(ctx.state),
    };
    const result = await executeToolCall("stateTool", {}, { tool, env: {} });
    expect(JSON.parse(result)).toEqual({});
  });

  test("uses default empty messages when messages not provided", async () => {
    const tool: ToolDef = {
      description: "Get messages",
      execute: (_args, ctx) => JSON.stringify(ctx.messages),
    };
    const result = await executeToolCall("msgTool", {}, { tool, env: {} });
    expect(JSON.parse(result)).toEqual([]);
  });

  test("uses default empty sessionId when not provided", async () => {
    const tool: ToolDef = {
      description: "Get sessionId",
      execute: (_args, ctx) => ctx.sessionId,
    };
    const result = await executeToolCall("sidTool", {}, { tool, env: {} });
    expect(result).toBe("");
  });

  test("tool with no parameters schema accepts any args", async () => {
    const tool: Parameters<typeof executeToolCall>[2]["tool"] = {
      description: "No params",
      execute: () => "ok",
    };
    const result = await executeToolCall("noParamsTool", { any: "thing" }, { tool, env: {} });
    expect(result).toBe("ok");
  });
});

describe("createRuntime sandbox mode", () => {
  test("uses provided executeTool and merges default builtins into toolSchemas", async () => {
    const mockExecuteTool = vi.fn(async () => "mocked-result");
    const mockToolSchemas = [
      { type: "function" as const, name: "mock_tool", description: "A mock tool", parameters: {} },
    ];

    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: mockToolSchemas,
    });

    // Relay/host-mode path: the agent has no explicit builtinTools, so the
    // cognitive defaults are resolved here and appended to the relayed schemas.
    expect(runtime.toolSchemas.map((s) => s.name)).toEqual([
      "mock_tool",
      "think",
      "remember",
      "recall",
      "calculate",
    ]);
    const result = await runtime.executeTool("any_tool", {}, "s1", []);
    expect(result).toBe("mocked-result");
    // The wrapper forwards a 5th `callOpts` arg (undefined when omitted).
    expect(mockExecuteTool).toHaveBeenCalledWith("any_tool", {}, "s1", [], undefined);
  });

  test("default builtins execute host-side, not via the relay", async () => {
    const mockExecuteTool = vi.fn(async () => "relayed");
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: [],
    });

    const result = await runtime.executeTool("think", { thought: "check the policy" }, "s1", []);
    expect(result).toBe("ok");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  test("a relayed tool with a builtin's name wins — the builtin is dropped", async () => {
    const mockExecuteTool = vi.fn(async () => "relayed");
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: [
        { type: "function" as const, name: "think", description: "Client think", parameters: {} },
      ],
    });

    expect(runtime.toolSchemas.filter((s) => s.name === "think")).toHaveLength(1);
    expect(runtime.toolSchemas[0]?.description).toBe("Client think");
    const result = await runtime.executeTool("think", { thought: "x" }, "s1", []);
    expect(result).toBe("relayed");
    expect(mockExecuteTool).toHaveBeenCalledOnce();
  });

  test("explicit builtinTools: [] disables the defaults", () => {
    const mockToolSchemas = [
      { type: "function" as const, name: "mock_tool", description: "A mock tool", parameters: {} },
    ];
    const runtime = createRuntime({
      agent: makeAgent({ builtinTools: [] }),
      env: {},
      executeTool: vi.fn(async () => "ok"),
      toolSchemas: mockToolSchemas,
    });
    expect(runtime.toolSchemas.map((s) => s.name)).toEqual(["mock_tool"]);
  });

  test("pre-resolved builtinDefs skip the merge (platform sandbox path)", () => {
    const mockToolSchemas = [
      { type: "function" as const, name: "mock_tool", description: "A mock tool", parameters: {} },
    ];
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: vi.fn(async () => "ok"),
      toolSchemas: mockToolSchemas,
      builtinDefs: {},
    });
    // The caller owns schema merging in this path; nothing is appended.
    expect(runtime.toolSchemas).toBe(mockToolSchemas);
  });
});

// ── Shared conformance suite (same tests run against sandbox in integration) ─

const directExec = createRuntime({
  agent: CONFORMANCE_AGENT,
  env: { MY_VAR: "test-value" },
});

testRuntime("direct", () => ({
  executeTool: directExec.executeTool,
}));
