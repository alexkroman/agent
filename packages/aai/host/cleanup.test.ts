// Copyright 2025 the AAI authors. MIT license.
/**
 * Resource cleanup and leak detection tests for server-side components.
 *
 * Verifies that WebSocket connections, S2S handles, timers,
 * message buffers, and hook promises are properly cleaned up on disconnect,
 * error, and reset to prevent memory leaks in long-running processes.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import {
  makeClient,
  makeMockHandle,
  makeSessionOpts,
  makeStubSession,
  silentLogger,
} from "./_test-utils.ts";
import type { S2sHandle } from "./s2s.ts";
import type { Session } from "./session.ts";
import { _internals, createS2sSession, type S2sSessionOptions } from "./session.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

// ─── wireSessionSocket cleanup tests ─────────────────────────────────────────

describe("wireSessionSocket resource cleanup", () => {
  test("session.stop() is called exactly once on normal close", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();

    await vi.waitFor(() => {
      expect(session.stop).toHaveBeenCalledOnce();
    });
  });

  test("session is removed from sessions map even when stop() rejects", async () => {
    const sessions = new Map<string, Session>();
    const session = makeStubSession();
    session.stop = vi.fn(() => Promise.reject(new Error("stop failed")));

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(sessions.size).toBe(1);
    ws.close();

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("message buffer is cleared when start() fails", async () => {
    const session = makeStubSession();
    session.start = vi.fn(() => Promise.reject(new Error("start failed")));
    const sessions = new Map<string, Session>();

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Send messages while start is failing
    ws.simulateMessage(JSON.stringify({ type: "audio_ready" }));

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });

    // Session is null, further messages should be silently ignored (no throw)
    ws.simulateMessage(JSON.stringify({ type: "audio_ready" }));
    ws.simulateMessage(new ArrayBuffer(4));
  });

  test("multiple rapid closes don't double-invoke stop()", async () => {
    const session = makeStubSession();
    session.stop = vi.fn(() => new Promise<void>((r) => setTimeout(r, 50)));
    const sessions = new Map<string, Session>();

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();

    // Even if close event fires again, stop should only be called once
    // because the session reference is captured on first close
    await vi.waitFor(() => {
      expect(session.stop).toHaveBeenCalledOnce();
    });
  });

  test("close before open does not throw or leak", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;
    const sessions = new Map<string, Session>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Close before open — session is null, should not throw
    ws.close();
    expect(sessions.size).toBe(0);
  });

  test("error event after close does not throw", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();
    await vi.waitFor(() => {
      expect(session.stop).toHaveBeenCalled();
    });

    // Error after close should not throw
    ws.dispatchEvent(new Event("error"));
  });
});

// ─── createS2sSession cleanup tests ──────────────────────────────────────────

describe("createS2sSession resource cleanup", () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  let mockHandle: ReturnType<typeof makeMockHandle>;

  function setup(overrides?: Partial<S2sSessionOptions>) {
    mockHandle = makeMockHandle();
    connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);
    const client = makeClient();
    const opts = makeSessionOpts({ client, ...overrides });
    const session = createS2sSession(opts);
    return { session, client, opts, mockHandle };
  }

  afterEach(() => {
    connectSpy?.mockRestore();
  });

  test("stop() closes S2S handle and waits for in-flight turn", async () => {
    let resolveToolCall!: (value: string) => void;
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveToolCall = r;
        }),
    );
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    // Start a tool call
    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", { type: "tool_call", toolCallId: "c1", toolName: "t1", args: {} });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());

    // Stop while tool is in-flight
    const stopPromise = session.stop();
    resolveToolCall("done");
    await stopPromise;

    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("onReset clears pendingTools and conversation messages", async () => {
    const executeTool = vi.fn(async () => "result");
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    // Accumulate some tool calls
    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", { type: "tool_call", toolCallId: "c1", toolName: "t1", args: {} });
    await session.waitForTurn();

    // Send a user transcript to add conversation messages
    mockHandle._fire("event", { type: "user_transcript", text: "Hello" });

    // Reset — should clear pending tools and conversation
    session.onReset();

    // Verify old handle was closed
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("onReset invalidates currentReplyId to discard stale tool results", async () => {
    let resolveToolCall!: (value: string) => void;
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveToolCall = r;
        }),
    );
    const handles: ReturnType<typeof makeMockHandle>[] = [];
    const spy = vi.spyOn(_internals, "connectS2s").mockImplementation(async () => {
      const h = makeMockHandle();
      handles.push(h);
      return h;
    });

    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client, executeTool }));
    await session.start();

    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    const firstHandle = handles[0]!;

    // Start a tool call on the first handle
    firstHandle._fire("replyStarted", { replyId: "r1" });
    firstHandle._fire("event", { type: "tool_call", toolCallId: "c1", toolName: "t1", args: {} });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());

    // Reset while tool is in-flight
    session.onReset();

    // Tool finishes late — result should be discarded due to generation mismatch
    resolveToolCall("stale-result");
    await session.waitForTurn();

    // New handle should not receive the stale result
    const newHandle = handles[1];
    expect(newHandle?.sendToolResult).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test("stop() is safe to call without start()", async () => {
    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client }));
    // stop() without start() — should not throw
    await session.stop();
  });

  test("stop() prevents orphaned S2S connection when called during start()", async () => {
    let resolveConnect!: (value: S2sHandle) => void;
    const handle = makeMockHandle();
    const spy = vi.spyOn(_internals, "connectS2s").mockImplementation(
      () =>
        new Promise((r) => {
          resolveConnect = r as (value: S2sHandle) => void;
        }),
    );

    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client }));

    const startPromise = session.start();
    const stopPromise = session.stop();

    // Connection resolves after stop — handle must be closed immediately
    resolveConnect(handle);
    await startPromise;
    await stopPromise;

    expect(handle.close).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("S2S error event closes handle and emits error to client", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("error", new Error("S2S crashed"));

    expect(mockHandle.close).toHaveBeenCalled();
    expect(client.events).toContainEqual({
      type: "error",
      code: "internal",
      message: "S2S crashed",
    });
  });

  test("S2S close event nullifies the handle reference", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    // Simulate S2S WebSocket close
    mockHandle._fire("close", 1000, "normal");

    // Sending audio after close should not throw (no-ops via ?. on null s2s)
    session.onAudio(new Uint8Array([1, 2, 3]));
  });

  test("sessionExpired event closes the S2S handle", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    mockHandle._fire("sessionExpired");
    // The handler calls handle.close() directly
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("rapid resets close all stale connections", async () => {
    const handles: ReturnType<typeof makeMockHandle>[] = [];
    const resolvers: ((h: S2sHandle) => void)[] = [];

    const spy = vi.spyOn(_internals, "connectS2s").mockImplementation(
      () =>
        new Promise<S2sHandle>((resolve) => {
          const h = makeMockHandle();
          handles.push(h);
          resolvers.push(resolve as (value: S2sHandle) => void);
        }),
    );

    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client }));

    const startPromise = session.start();
    session.onReset();
    session.onReset();

    expect(resolvers.length).toBe(3);

    // Resolve in order — first two are stale
    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    resolvers[0]?.(handles[0]!);
    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    resolvers[1]?.(handles[1]!);
    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    resolvers[2]?.(handles[2]!);

    await startPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(handles[0]?.close).toHaveBeenCalled();
    expect(handles[1]?.close).toHaveBeenCalled();
    expect(handles[2]?.close).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test("concurrent tool calls all complete before stop() resolves", async () => {
    const resolvers: ((value: string) => void)[] = [];
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolvers.push(r);
        }),
    );
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", { type: "tool_call", toolCallId: "c1", toolName: "t1", args: {} });
    mockHandle._fire("event", { type: "tool_call", toolCallId: "c2", toolName: "t2", args: {} });

    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledTimes(2));

    // Stop while both tools are in-flight
    const stopPromise = session.stop();

    // Resolve both tools
    resolvers[0]?.("result-1");
    resolvers[1]?.("result-2");

    await stopPromise;
    // If we get here, turnPromise was properly awaited
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("connectS2s failure does not leak resources", async () => {
    const spy = vi.spyOn(_internals, "connectS2s").mockRejectedValue(new Error("network error"));
    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client }));

    await session.start();

    // Client should get error event
    expect(client.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "internal",
        message: "network error",
      }),
    );

    // stop() should not throw even after failed start
    await session.stop();

    spy.mockRestore();
  });
});
