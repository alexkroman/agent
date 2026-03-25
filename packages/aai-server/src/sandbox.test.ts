// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IsolateConfig } from "./_harness-protocol.ts";
import { _internals } from "./sandbox.ts";

// ── toAgentConfig ────────────────────────────────────────────────────────

describe("toAgentConfig", () => {
  const baseConfig: IsolateConfig = {
    name: "test-agent",
    instructions: "Be helpful",
    greeting: "Hello!",
    toolSchemas: [],
    hasState: false,
    hooks: {
      onConnect: false,
      onDisconnect: false,
      onError: false,
      onTurn: false,
      onStep: false,
      onBeforeStep: false,
      maxStepsIsFn: false,
    },
  };

  it("maps required fields", () => {
    const ac = _internals.toAgentConfig(baseConfig);
    expect(ac.name).toBe("test-agent");
    expect(ac.instructions).toBe("Be helpful");
    expect(ac.greeting).toBe("Hello!");
  });

  it("includes optional fields when present", () => {
    const config: IsolateConfig = {
      ...baseConfig,
      sttPrompt: "Technical terms",
      maxSteps: 10,
      toolChoice: "required",
      builtinTools: ["web_search", "run_code"],
      activeTools: ["greet", "search"],
    };
    const ac = _internals.toAgentConfig(config);
    expect(ac.sttPrompt).toBe("Technical terms");
    expect(ac.maxSteps).toBe(10);
    expect(ac.toolChoice).toBe("required");
    expect(ac.builtinTools).toEqual(["web_search", "run_code"]);
    expect(ac.activeTools).toEqual(["greet", "search"]);
  });

  it("omits optional fields when undefined", () => {
    const ac = _internals.toAgentConfig(baseConfig);
    expect(ac).not.toHaveProperty("sttPrompt");
    expect(ac).not.toHaveProperty("maxSteps");
    expect(ac).not.toHaveProperty("toolChoice");
    expect(ac).not.toHaveProperty("builtinTools");
    expect(ac).not.toHaveProperty("activeTools");
  });
});

// ── buildExecuteTool ─────────────────────────────────────────────────────

describe("buildExecuteTool", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls /tool endpoint and returns result", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ result: "tool-output", state: {} }));

    const exec = _internals.buildExecuteTool("http://127.0.0.1:9999");
    const result = await exec("my_tool", { x: 1 }, "session-1", []);

    expect(result).toBe("tool-output");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/tool",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "my_tool",
          args: { x: 1 },
          sessionId: "session-1",
          messages: [],
        }),
      }),
    );
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 }));

    const exec = _internals.buildExecuteTool("http://127.0.0.1:9999");
    await expect(exec("bad_tool", {}, "s1", [])).rejects.toThrow("tool failed: 500");
  });
});

// ── buildHookInvoker ─────────────────────────────────────────────────────

describe("buildHookInvoker", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockHookResponse(result: unknown = undefined) {
    globalThis.fetch = vi.fn(async () => Response.json({ state: {}, result }));
  }

  it("onConnect sends correct hook name", async () => {
    mockHookResponse();
    const invoker = _internals.buildHookInvoker("http://127.0.0.1:9999");
    await invoker.onConnect("session-1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/hook",
      expect.objectContaining({
        body: JSON.stringify({ hook: "onConnect", sessionId: "session-1" }),
      }),
    );
  });

  it("onTurn sends text", async () => {
    mockHookResponse();
    const invoker = _internals.buildHookInvoker("http://127.0.0.1:9999");
    await invoker.onTurn("s1", "Hello");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/hook",
      expect.objectContaining({
        body: JSON.stringify({ hook: "onTurn", sessionId: "s1", text: "Hello" }),
      }),
    );
  });

  it("onStep sends step data", async () => {
    mockHookResponse();
    const invoker = _internals.buildHookInvoker("http://127.0.0.1:9999");
    const step = { stepNumber: 1, toolCalls: [{ toolName: "t", args: {} }], text: "" };
    await invoker.onStep("s1", step);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/hook",
      expect.objectContaining({
        body: JSON.stringify({ hook: "onStep", sessionId: "s1", step }),
      }),
    );
  });

  it("resolveTurnConfig returns parsed config", async () => {
    mockHookResponse({ maxSteps: 3, activeTools: ["search"] });
    const invoker = _internals.buildHookInvoker("http://127.0.0.1:9999");
    const config = await invoker.resolveTurnConfig("s1");

    expect(config).toEqual({ maxSteps: 3, activeTools: ["search"] });
  });

  it("resolveTurnConfig returns null when hook returns null", async () => {
    mockHookResponse(null);
    const invoker = _internals.buildHookInvoker("http://127.0.0.1:9999");
    const config = await invoker.resolveTurnConfig("s1");
    expect(config).toBeNull();
  });

  it("resolveTurnConfig omits undefined fields", async () => {
    mockHookResponse({});
    const invoker = _internals.buildHookInvoker("http://127.0.0.1:9999");
    const config = await invoker.resolveTurnConfig("s1");
    expect(config).toEqual({});
  });
});

// ── getIsolateConfig ─────────────────────────────────────────────────────

describe("getIsolateConfig", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses valid config response", async () => {
    const config: IsolateConfig = {
      name: "agent",
      instructions: "inst",
      greeting: "hi",
      toolSchemas: [
        { name: "t", description: "d", parameters: { type: "object", properties: {} } },
      ],
      hasState: true,
      hooks: {
        onConnect: true,
        onDisconnect: false,
        onError: false,
        onTurn: true,
        onStep: false,
        onBeforeStep: false,
        maxStepsIsFn: false,
      },
    };
    globalThis.fetch = vi.fn(async () => Response.json(config));

    const result = await _internals.getIsolateConfig(12345);
    expect(result.name).toBe("agent");
    expect(result.toolSchemas).toHaveLength(1);
    expect(result.hooks.onConnect).toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:12345/config",
      expect.anything(),
    );
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(_internals.getIsolateConfig(9999)).rejects.toThrow("/config failed: 503");
  });
});

// ── _internals.IDLE_MS proxy ─────────────────────────────────────────────

describe("_internals.IDLE_MS", () => {
  let saved: number;

  beforeEach(() => {
    saved = _internals.IDLE_MS;
  });

  afterEach(() => {
    _internals.IDLE_MS = saved;
  });

  it("proxies get/set to _slotInternals", () => {
    _internals.IDLE_MS = 42;
    expect(_internals.IDLE_MS).toBe(42);
  });
});
