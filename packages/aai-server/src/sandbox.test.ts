// Copyright 2025 the AAI authors. MIT license.

import {
  callBeforeTurn,
  callInterceptToolCall,
  callResolveTurnConfig,
  callTextHook,
} from "@alexkroman1/aai/internal";
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
      maxStepsIsFn: false,
      hasMiddleware: false,
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
    };
    const ac = _internals.toAgentConfig(config);
    expect(ac.sttPrompt).toBe("Technical terms");
    expect(ac.maxSteps).toBe(10);
    expect(ac.toolChoice).toBe("required");
    expect(ac.builtinTools).toEqual(["web_search", "run_code"]);
  });

  it("omits optional fields when undefined", () => {
    const ac = _internals.toAgentConfig(baseConfig);
    expect(ac).not.toHaveProperty("sttPrompt");
    expect(ac).not.toHaveProperty("maxSteps");
    expect(ac).not.toHaveProperty("toolChoice");
    expect(ac).not.toHaveProperty("builtinTools");
  });
});

// ── buildExecuteTool ─────────────────────────────────────────────────────

describe("buildExecuteTool", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls /rpc endpoint with type:tool and returns result", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ result: "tool-output", state: {} }));

    const exec = _internals.buildExecuteTool("http://127.0.0.1:9999", "test-token");
    const result = await exec("my_tool", { x: 1 }, "session-1", []);

    expect(result).toBe("tool-output");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "tool",
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

    const exec = _internals.buildExecuteTool("http://127.0.0.1:9999", "test-token");
    await expect(exec("bad_tool", {}, "s1", [])).rejects.toThrow("rpc (tool) failed (500):");
  });

  it("aborts immediately when crash signal fires", async () => {
    globalThis.fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const controller = new AbortController();
    const exec = _internals.buildExecuteTool(
      "http://127.0.0.1:9999",
      "test-token",
      controller.signal,
    );
    const promise = exec("slow_tool", {}, "s1", []);
    controller.abort(new Error("Isolate crashed"));
    await expect(promise).rejects.toThrow("Isolate crashed");
  });
});

// ── buildHookInvoker ─────────────────────────────────────────────────────

describe("buildHookInvoker", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockHookResponse(result?: unknown) {
    globalThis.fetch = vi.fn(async () => Response.json({ state: {}, result }));
  }

  it("aborts immediately when crash signal fires", async () => {
    globalThis.fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const controller = new AbortController();
    const hooks = _internals.buildHookInvoker(
      "http://127.0.0.1:9999",
      "test-token",
      controller.signal,
    );
    const promise = hooks.callHook("connect", "s1");
    controller.abort(new Error("Isolate crashed"));
    await expect(promise).rejects.toThrow("Isolate crashed");
  });

  it("connect sends correct hook name via /rpc", async () => {
    mockHookResponse();
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    await hooks.callHook("connect", "session-1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({ type: "hook", hook: "onConnect", sessionId: "session-1" }),
      }),
    );
  });

  it("turn sends text", async () => {
    mockHookResponse();
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    await hooks.callHook("turn", "s1", "Hello");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({ type: "hook", hook: "onTurn", sessionId: "s1", text: "Hello" }),
      }),
    );
  });

  it("resolveTurnConfig returns parsed config", async () => {
    mockHookResponse({ maxSteps: 3 });
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    const config = await callResolveTurnConfig(hooks, "s1");
    expect(config).toEqual({ maxSteps: 3 });
  });

  it("resolveTurnConfig returns null when hook returns null", async () => {
    mockHookResponse(null);
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    const config = await callResolveTurnConfig(hooks, "s1");
    expect(config).toBeNull();
  });

  it("resolveTurnConfig omits undefined fields", async () => {
    mockHookResponse({});
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    const config = await callResolveTurnConfig(hooks, "s1");
    expect(config).toEqual({});
  });

  it("beforeTurn sends text and returns result", async () => {
    mockHookResponse("blocked");
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    const result = await callBeforeTurn(hooks, "s1", "hello");
    expect(result).toBe("blocked");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({ type: "hook", hook: "beforeTurn", sessionId: "s1", text: "hello" }),
      }),
    );
  });

  it("afterTurn sends text", async () => {
    mockHookResponse();
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    await hooks.callHook("afterTurn", "s1", "response");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({
          type: "hook",
          hook: "afterTurn",
          sessionId: "s1",
          text: "response",
        }),
      }),
    );
  });

  it("interceptToolCall sends tool name and args", async () => {
    mockHookResponse({ type: "block", reason: "not allowed" });
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    const result = await callInterceptToolCall(hooks, "s1", "search", { q: "test" });
    expect(result).toEqual({ type: "block", reason: "not allowed" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({
          type: "hook",
          hook: "interceptToolCall",
          sessionId: "s1",
          toolName: "search",
          toolArgs: { q: "test" },
        }),
      }),
    );
  });

  it("afterToolCall sends tool name, args, and result", async () => {
    mockHookResponse();
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    await hooks.callHook("afterToolCall", "s1", "search", { q: "test" }, "found it");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({
          type: "hook",
          hook: "afterToolCall",
          sessionId: "s1",
          toolName: "search",
          toolArgs: { q: "test" },
          text: "found it",
        }),
      }),
    );
  });

  it("filterOutput sends text and returns filtered result", async () => {
    mockHookResponse("sanitized text");
    const hooks = _internals.buildHookInvoker("http://127.0.0.1:9999", "test-token");
    const result = await callTextHook(hooks, "filterOutput", "s1", "raw text");
    expect(result).toBe("sanitized text");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/rpc",
      expect.objectContaining({
        body: JSON.stringify({
          type: "hook",
          hook: "filterOutput",
          sessionId: "s1",
          text: "raw text",
        }),
      }),
    );
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
        maxStepsIsFn: false,
        hasMiddleware: false,
      },
    };
    globalThis.fetch = vi.fn(async () => Response.json(config));

    const result = await _internals.getIsolateConfig(12_345, "test-token");
    expect(result.name).toBe("agent");
    expect(result.toolSchemas).toHaveLength(1);
    expect(result.hooks.onConnect).toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:12345/rpc",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "x-harness-token": "test-token" },
        body: JSON.stringify({ type: "config" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(_internals.getIsolateConfig(9999, "test-token")).rejects.toThrow(
      "/rpc (config) failed (503):",
    );
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
