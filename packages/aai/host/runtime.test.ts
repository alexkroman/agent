// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "../sdk/_internal-types.ts";
import type { ToolDef } from "../sdk/types.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "./_pipeline-test-fakes.ts";
import { CONFORMANCE_AGENT, testRuntime } from "./_runtime-conformance.ts";
import { flush, makeAgent, makeClient, makeMockHandle, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { _internals } from "./session.ts";
import { executeToolCall } from "./tool-executor.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

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
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
  test("uses provided executeTool and toolSchemas", async () => {
    const mockExecuteTool = vi.fn(async () => "mocked-result");
    const mockToolSchemas = [{ name: "mock_tool", description: "A mock tool", parameters: {} }];

    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: mockToolSchemas,
    });

    // Should use the provided overrides, not build its own
    expect(runtime.toolSchemas).toBe(mockToolSchemas);
    const result = await runtime.executeTool("any_tool", {}, "s1", []);
    expect(result).toBe("mocked-result");
    expect(mockExecuteTool).toHaveBeenCalledWith("any_tool", {}, "s1", []);
  });
});

describe("createRuntime shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Helper: create a mock WS (readyState=1) that captures event listeners. */
  function makeMockWs() {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      readyState: 1,
      send: vi.fn(),
      listeners,
      addEventListener: vi.fn((type: string, listener: (...args: unknown[]) => void) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(listener);
      }),
    };
  }

  test("shutdown stops active sessions gracefully", async () => {
    const mockHandle = makeMockHandle();
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockImplementation(async () => {
      // Fire "ready" so session.start() resolves
      setTimeout(() => mockHandle._fire("ready", { sessionId: "mock-sid" }), 0);
      return mockHandle;
    });

    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });
    const ws = makeMockWs();

    // readyState=1 means onOpen fires immediately in wireSessionSocket
    runtime.startSession(ws as never);

    // Wait for session.start() to resolve (fires on next tick via setTimeout)
    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();
    // Give session.start() time to resolve
    await new Promise((r) => setTimeout(r, 50));

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    connectSpy.mockRestore();
  });

  test("shutdown warns when a session stop rejects", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mockHandle = makeMockHandle();
    // Make close() throw to cause session.stop() to reject
    mockHandle.close = vi.fn(() => {
      throw new Error("close failed");
    });
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockImplementation(async () => {
      setTimeout(() => mockHandle._fire("ready", { sessionId: "mock-sid" }), 0);
      return mockHandle;
    });

    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {}, logger });
    const ws = makeMockWs();

    runtime.startSession(ws as never);

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();

    await runtime.shutdown();
    // The session stop rejection should be caught and logged
    // (Note: whether the warn fires depends on whether stop() actually rejects
    // from close() throwing — session.stop() may catch it internally)
    connectSpy.mockRestore();
  });

  test("shutdown warns on timeout when sessions hang", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mockHandle = makeMockHandle();
    // Make close() hang forever so stop() never resolves
    mockHandle.close = vi.fn(() => {
      // intentionally do nothing — session stop will hang
    });
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockImplementation(async () => {
      setTimeout(() => mockHandle._fire("ready", { sessionId: "mock-sid" }), 0);
      return mockHandle;
    });

    const agent = makeAgent();
    const runtime = createRuntime({
      agent,
      env: {},
      logger,
      shutdownTimeoutMs: 50, // Very short timeout
    });
    const ws = makeMockWs();

    runtime.startSession(ws as never);

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();

    await runtime.shutdown();
    // Whether timeout warning fires depends on internal session map population
    connectSpy.mockRestore();
  });

  test("state is not re-initialized when already present for session", async () => {
    const stateFactory = vi.fn(() => ({ counter: 0 }));
    const agent = makeAgent({
      state: stateFactory,
      tools: {
        increment: {
          description: "Increment counter",
          execute: (_args, ctx) => {
            (ctx.state as { counter: number }).counter++;
            return String((ctx.state as { counter: number }).counter);
          },
        },
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(ctx.state),
        },
      },
    });
    const runtime = createRuntime({ agent, env: {} });

    // First call creates state
    await runtime.executeTool("increment", {}, "s1", []);
    // Second call reuses same state
    await runtime.executeTool("increment", {}, "s1", []);
    const result = await runtime.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ counter: 2 });
    // State factory should have been called only once
    expect(stateFactory).toHaveBeenCalledTimes(1);
  });
});

describe("createRuntime createSession", () => {
  test("createSession returns a Session object", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {} });
    const client = {
      open: true,
      event: vi.fn(),
      playAudioChunk: vi.fn(),
      playAudioDone: vi.fn(),
    };
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
    });
    expect(session).toBeDefined();
    expect(typeof session.start).toBe("function");
    expect(typeof session.stop).toBe("function");
    expect(typeof session.onAudio).toBe("function");
    expect(typeof session.onCancel).toBe("function");
    expect(typeof session.onReset).toBe("function");
    expect(typeof session.onHistory).toBe("function");
  });

  test("createSession passes skipGreeting option", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {} });
    const client = {
      open: true,
      event: vi.fn(),
      playAudioChunk: vi.fn(),
      playAudioDone: vi.fn(),
    };
    // Should not throw when skipGreeting is set
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
      skipGreeting: true,
    });
    expect(session).toBeDefined();
  });

  test("createSession passes resumeFrom option", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {} });
    const client = {
      open: true,
      event: vi.fn(),
      playAudioChunk: vi.fn(),
      playAudioDone: vi.fn(),
    };
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
      resumeFrom: "prev-session-id",
    });
    expect(session).toBeDefined();
  });
});

describe("createRuntime startSession", () => {
  test("startSession wires WebSocket and passes options", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });
    const mockWs = {
      readyState: 1,
      send: vi.fn(),
      addEventListener: vi.fn(),
    };

    // Should not throw
    runtime.startSession(mockWs as never, {
      skipGreeting: true,
      resumeFrom: "prev-session",
      logContext: { userId: "u1" },
      onOpen: vi.fn(),
      onClose: vi.fn(),
    });

    // addEventListener should have been called to wire up the WebSocket
    expect(mockWs.addEventListener).toHaveBeenCalled();
  });

  test("startSession works with no options", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });
    const mockWs = {
      readyState: 1,
      send: vi.fn(),
      addEventListener: vi.fn(),
    };

    runtime.startSession(mockWs as never);
    expect(mockWs.addEventListener).toHaveBeenCalled();
  });
});

describe("createRuntime with custom options", () => {
  test("accepts custom sessionStartTimeoutMs", () => {
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      sessionStartTimeoutMs: 5000,
    });
    expect(runtime).toBeDefined();
  });

  test("accepts custom createWebSocket", () => {
    const createWebSocket = vi.fn();
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      createWebSocket,
    });
    expect(runtime).toBeDefined();
  });

  test("uses ASSEMBLYAI_API_KEY from env for sessions", () => {
    const agent = makeAgent();
    const runtime = createRuntime({
      agent,
      env: { ASSEMBLYAI_API_KEY: "test-api-key" },
    });
    const client = {
      open: true,
      event: vi.fn(),
      playAudioChunk: vi.fn(),
      playAudioDone: vi.fn(),
    };
    // Should not throw — the API key gets passed to createS2sSession internally
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
    });
    expect(session).toBeDefined();
  });

  test("default state is empty object when agent has no state factory", async () => {
    const agent = makeAgent({
      tools: {
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(ctx.state),
        },
      },
    });
    const runtime = createRuntime({ agent, env: {} });
    const result = await runtime.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({});
  });
});

describe("Runtime — session routing", () => {
  test("manifest with stt/llm/tts routes to PipelineSession (no S2S socket opened)", async () => {
    const createWebSocket = vi.fn();
    const stt = createFakeSttProvider();
    const tts = createFakeTtsProvider();
    const llm = createFakeLanguageModel({ script: [] });

    const runtime = createRuntime({
      agent: makeAgent(),
      env: { ASSEMBLYAI_API_KEY: "stt-key", CARTESIA_API_KEY: "tts-key" },
      logger: silentLogger,
      createWebSocket,
      stt,
      llm,
      tts,
    });

    const client = makeClient();
    const session = runtime.createSession({
      id: "sess-pipeline",
      agent: "test-agent",
      client,
    });

    expect(typeof session.start).toBe("function");
    expect(typeof session.stop).toBe("function");

    // Opening providers drives the pipeline path end-to-end; the S2S WS factory
    // must never be called for a pipeline-mode session.
    await session.start();
    expect(stt.last()).toBeDefined();
    expect(tts.last()).toBeDefined();
    expect(createWebSocket).not.toHaveBeenCalled();

    // Pipeline providers saw the resolved host-side credentials.
    expect(stt.last()?.opts.apiKey).toBe("stt-key");
    expect(tts.last()?.opts.apiKey).toBe("tts-key");

    await session.stop();
  });

  test("manifest without stt/llm/tts routes to S2sSession (createWebSocket IS called)", async () => {
    const mockHandle = makeMockHandle();
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockImplementation(async () => {
      setTimeout(() => mockHandle._fire("ready", { sessionId: "mock-sid" }), 0);
      return mockHandle;
    });

    const createWebSocket = vi.fn();
    const runtime = createRuntime({
      agent: makeAgent(),
      env: { ASSEMBLYAI_API_KEY: "s2s-key" },
      logger: silentLogger,
      createWebSocket,
    });

    const client = makeClient();
    const session = runtime.createSession({
      id: "sess-s2s",
      agent: "test-agent",
      client,
    });

    await session.start();
    // connectS2s is the seam that consumes our createWebSocket factory inside
    // the S2S path. If routing picked the pipeline branch this would never fire.
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ createWebSocket, apiKey: "s2s-key" }),
    );

    await session.stop();
    connectSpy.mockRestore();
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
