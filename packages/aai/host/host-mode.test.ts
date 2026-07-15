// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolSchema } from "../sdk/_internal-types.ts";
import type { ClientEvent } from "../sdk/protocol.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeConfig, makeLogger, silentLogger } from "./_test-utils.ts";
import {
  buildHostAgent,
  createRelayExecuteTool,
  isHostAllowed,
  startHostSession,
} from "./host-mode.ts";
import type { Runtime, RuntimeOptions } from "./runtime.ts";
import { createSessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";
import type { SessionWebSocket } from "./ws-handler.ts";
import { wireSessionSocket } from "./ws-handler.ts";

type ToolCallEvent = Extract<ClientEvent, { type: "tool_call" }>;

const TOOL_SCHEMA: ToolSchema = {
  type: "function",
  name: "lookup",
  description: "Look something up",
  parameters: {},
};

function hostConfigFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "config",
    host: { systemPrompt: "You are a host agent.", greeting: "Hi.", tools: [TOOL_SCHEMA] },
    sampleRate: 8000,
    ttsSampleRate: 16_000,
    ...overrides,
  });
}

function makeFakeRuntime(o: RuntimeOptions): {
  runtime: Runtime;
  startSession: ReturnType<typeof vi.fn>;
} {
  const startSession = vi.fn();
  const runtime = {
    startSession,
    shutdown: vi.fn(() => Promise.resolve()),
    readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
    executeTool: o.executeTool ?? (() => Promise.resolve("")),
    toolSchemas: o.toolSchemas ?? [],
    createSession: vi.fn(),
  } as unknown as Runtime;
  return { runtime, startSession };
}

function makeFakeTransport(): Transport {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

function openMockWs(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

function makeSend() {
  const events: ToolCallEvent[] = [];
  const send = vi.fn((e: ToolCallEvent) => {
    events.push(e);
  });
  return { send, events };
}

describe("createRelayExecuteTool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("emits a tool_call frame and resolves on a matching tool_result", async () => {
    const { send, events } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const p = relay.executeTool("lookup", { city: "Paris" }, "sess", [], {
      toolCallId: "call-1",
    });

    expect(events).toEqual([
      { type: "tool_call", toolCallId: "call-1", toolName: "lookup", args: { city: "Paris" } },
    ]);

    relay.onToolResult({ toolCallId: "call-1", result: "sunny" });
    await expect(p).resolves.toBe("sunny");
    relay.dispose();
  });

  test("unwraps a JSON-encoded string result but leaves object JSON intact", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const pStr = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "a" });
    relay.onToolResult({ toolCallId: "a", result: '"hello"' });
    await expect(pStr).resolves.toBe("hello");

    const pObj = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "b" });
    relay.onToolResult({ toolCallId: "b", result: '{"temp":72}' });
    await expect(pObj).resolves.toBe('{"temp":72}');

    const pPlain = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "c" });
    relay.onToolResult({ toolCallId: "c", result: "not json" });
    await expect(pPlain).resolves.toBe("not json");
  });

  test("rejects when the tool_result carries an error", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const p = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "err-1" });
    relay.onToolResult({ toolCallId: "err-1", result: "", error: "boom" });
    await expect(p).rejects.toThrow(/boom/);
  });

  test("ignores tool_result for an unknown toolCallId", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send, timeoutMs: 50 });
    vi.useFakeTimers();

    const p = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "known" });
    const settled = expect(p).rejects.toThrow(/timed out/);

    // A stray result for a different id must not resolve the pending call.
    relay.onToolResult({ toolCallId: "other", result: "nope" });

    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });

  test("times out when no tool_result arrives and cleans up", async () => {
    vi.useFakeTimers();
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send, timeoutMs: 1000 });

    const p = relay.executeTool("slow", {}, undefined, undefined, { toolCallId: "t-1" });
    const settled = expect(p).rejects.toThrow(/slow.*timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    // After timeout the entry is cleared: a late result is a no-op (does not throw).
    expect(() => relay.onToolResult({ toolCallId: "t-1", result: "late" })).not.toThrow();
  });

  test("returns a tool error (does not throw) when no toolCallId is provided", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const result = await relay.executeTool("t", {}, undefined, undefined, {});
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toMatchObject({ error: expect.stringContaining("toolCallId") });
  });

  test("dispose rejects all pending calls", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const p = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "x" });
    const settled = expect(p).rejects.toThrow(/dispose/i);
    relay.dispose();
    await settled;
  });

  test("a duplicate in-flight toolCallId is refused without clobbering the first call", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });

    const first = relay.executeTool("t", {}, undefined, undefined, { toolCallId: "dup" });
    const second = await relay.executeTool("t", {}, undefined, undefined, { toolCallId: "dup" });
    expect(JSON.parse(second)).toMatchObject({ error: expect.stringContaining("dup") });
    // Only the first call emitted a frame.
    expect(send).toHaveBeenCalledTimes(1);

    // The first call still settles from its genuine result.
    relay.onToolResult({ toolCallId: "dup", result: "first" });
    await expect(first).resolves.toBe("first");
    relay.dispose();
  });

  test("aborting the turn signal rejects the pending relay call; a late result is a no-op", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const controller = new AbortController();

    const p = relay.executeTool("t", {}, undefined, undefined, {
      toolCallId: "x",
      signal: controller.signal,
    });
    const settled = expect(p).rejects.toThrow(/cancelled/);
    controller.abort();
    await settled;

    // Entry was cleared: a stale client result after the abort is ignored.
    expect(() => relay.onToolResult({ toolCallId: "x", result: "late" })).not.toThrow();
    relay.dispose();
  });

  test("a pre-aborted signal returns a tool error without emitting a frame", async () => {
    const { send } = makeSend();
    const relay = createRelayExecuteTool({ send });
    const controller = new AbortController();
    controller.abort();

    const result = await relay.executeTool("t", {}, undefined, undefined, {
      toolCallId: "x",
      signal: controller.signal,
    });
    expect(JSON.parse(result)).toMatchObject({ error: expect.stringContaining("cancelled") });
    expect(send).not.toHaveBeenCalled();
    relay.dispose();
  });
});

describe("isHostAllowed", () => {
  test("defaults to enabled when unset or empty", () => {
    expect(isHostAllowed({})).toBe(true);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "" })).toBe(true);
  });

  test("enabled for 1/true (case-insensitive)", () => {
    expect(isHostAllowed({ AAI_ALLOW_HOST: "1" })).toBe(true);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "true" })).toBe(true);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "TRUE" })).toBe(true);
  });

  test("disabled for 0/false", () => {
    expect(isHostAllowed({ AAI_ALLOW_HOST: "0" })).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "false" })).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "False" })).toBe(false);
  });
});

describe("buildHostAgent", () => {
  test("maps systemPrompt/greeting and relays tools (no in-process tool defs)", () => {
    const agent = buildHostAgent({
      systemPrompt: "You are helpful.",
      greeting: "Hi there.",
      tools: [{ type: "function", name: "get_time", description: "Get the time", parameters: {} }],
    });
    expect(agent.systemPrompt).toBe("You are helpful.");
    expect(agent.greeting).toBe("Hi there.");
    // Host tools are relayed, not real ToolDefs, so the synthetic agent has none.
    expect(agent.tools).toEqual({});
    expect(typeof agent.maxSteps).toBe("number");
  });

  test("defaults greeting to empty string when omitted", () => {
    const agent = buildHostAgent({ systemPrompt: "P", tools: [] });
    expect(agent.greeting).toBe("");
  });
});

describe("startHostSession (deferred host handshake)", () => {
  test("first config.host frame builds a host runtime from the block and starts the session", () => {
    const ws = openMockWs();
    let captured: RuntimeOptions | undefined;
    let startSession: ReturnType<typeof vi.fn> = vi.fn();

    startHostSession(ws as unknown as SessionWebSocket, {
      env: {},
      logger: silentLogger,
      createRuntime: (o) => {
        captured = o;
        const fake = makeFakeRuntime(o);
        startSession = fake.startSession;
        return fake.runtime;
      },
    });

    ws.simulateMessage(hostConfigFrame());

    // Synthetic agent built from the host block.
    expect(captured?.agent.systemPrompt).toBe("You are a host agent.");
    expect(captured?.agent.greeting).toBe("Hi.");
    // Relay wiring: executeTool + toolSchemas + onToolResult all injected.
    expect(captured?.toolSchemas).toEqual([TOOL_SCHEMA]);
    expect(typeof captured?.executeTool).toBe("function");
    expect(typeof captured?.onToolResult).toBe("function");
    // Client-requested sample rates flow into the S2S config (requirement 5).
    expect(captured?.s2sConfig).toMatchObject({ inputSampleRate: 8000, outputSampleRate: 16_000 });
    // Session started on the fresh per-connection runtime, deferred to the frame.
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0]?.[0]).toBe(ws);
  });

  test("rejects with a protocol error when AAI_ALLOW_HOST is disabled", () => {
    const ws = openMockWs();
    const createRuntime = vi.fn();

    startHostSession(ws as unknown as SessionWebSocket, {
      env: { AAI_ALLOW_HOST: "0" },
      logger: silentLogger,
      createRuntime,
    });
    ws.simulateMessage(hostConfigFrame());

    expect(createRuntime).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: "error", code: "protocol" }),
    );
  });

  test("rejects when the first frame is not a valid host config", () => {
    const ws = openMockWs();
    const createRuntime = vi.fn();

    startHostSession(ws as unknown as SessionWebSocket, {
      env: {},
      logger: silentLogger,
      createRuntime,
    });
    ws.simulateMessage(JSON.stringify({ type: "audio_ready" }));

    expect(createRuntime).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: "error", code: "protocol" }),
    );
  });

  test("a client tool_result unblocks a relayed tool call end-to-end", async () => {
    // Wire a real SessionCore (relay mode) behind the real ws-handler dispatch,
    // proving: onToolCall relays via executeTool (no duplicate emit) and an
    // inbound tool_result frame routes through onToolResult to settle the call.
    // Live model-driven tool calls are exercised in Task A4.
    const ws = new MockWebSocket("ws://test");
    const relay = createRelayExecuteTool({ send: (e) => ws.send(JSON.stringify(e)) });
    const transport = makeFakeTransport();
    const logger = makeLogger();

    let core: ReturnType<typeof createSessionCore> | undefined;
    wireSessionSocket(ws as unknown as SessionWebSocket, {
      sessions: new Map(),
      logger,
      readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
      createSession: (_sid, client) => {
        core = createSessionCore({
          id: "s1",
          agent: "host",
          client,
          agentConfig: makeConfig(),
          executeTool: relay.executeTool,
          transport,
          onToolResult: relay.onToolResult,
          logger: silentLogger,
        });
        return core;
      },
    });

    await vi.waitFor(() => {
      expect(logger.info.mock.calls.map((c) => c[0])).toContain("Session ready");
    });
    if (!core) throw new Error("session core was not created");

    // Drive a tool call as an S2S transport would.
    core.onReplyStarted("r1");
    core.onToolCall("call-1", "lookup", { q: 1 });

    const toolCalls = ws.sentJson().filter((m) => m.type === "tool_call");
    expect(toolCalls).toEqual([
      { type: "tool_call", toolCallId: "call-1", toolName: "lookup", args: { q: 1 } },
    ]);

    // Client answers over the wire; dispatch → onToolResult → relay resolves.
    ws.simulateMessage(
      JSON.stringify({ type: "tool_result", toolCallId: "call-1", result: "sunny" }),
    );

    await vi.waitFor(() => {
      expect(ws.sentJson()).toContainEqual(
        expect.objectContaining({ type: "tool_call_done", toolCallId: "call-1", result: "sunny" }),
      );
    });
  });
});
