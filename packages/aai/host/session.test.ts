import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import {
  buildClientEvent,
  flush,
  makeClient,
  makeMockHandle,
  makeSessionOpts,
} from "./_test-utils.ts";
import type { S2sHandle } from "./s2s.ts";
import { _internals, createS2sSession, type S2sSessionOptions } from "./session.ts";

// ─── createS2sSession tests ─────────────────────────────────────────────────

describe("createS2sSession", () => {
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

  test("start() calls connectS2s", async () => {
    const { session } = setup();

    await session.start();
    expect(connectSpy).toHaveBeenCalledOnce();
  });

  test("start() sends updateSession with greeting on initial connect", async () => {
    const { session, mockHandle } = setup();
    await session.start();
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
    const arg = vi.mocked(mockHandle.updateSession).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg?.greeting).toBe("Hello!");
    expect(arg?.systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
  });

  test("skipGreeting clears greeting in updateSession", async () => {
    const { session, mockHandle } = setup({ skipGreeting: true });
    await session.start();
    const arg = vi.mocked(mockHandle.updateSession).mock.calls[0]?.[0];
    expect(arg?.greeting).toBeUndefined();
  });

  test("stop() aborts session and closes s2s handle", async () => {
    const { session, mockHandle } = setup();
    await session.start();
    await session.stop();
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("stop() is idempotent", async () => {
    const { session, mockHandle } = setup();
    await session.start();
    await session.stop();
    await session.stop();
    // close is only called once because second stop short-circuits
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  test("onAudio forwards data to s2s handle", async () => {
    const { session, mockHandle } = setup();
    await session.start();
    const audio = new Uint8Array([1, 2, 3, 4]);
    session.onAudio(audio);
    expect(mockHandle.sendAudio).toHaveBeenCalledWith(audio);
  });

  test("onAudioReady is idempotent", async () => {
    const { session } = setup();
    await session.start();
    session.onAudioReady();
    session.onAudioReady();
    // No error thrown, second call is a no-op
  });

  test("onCancel emits cancelled event", async () => {
    const { session, client } = setup();
    await session.start();
    session.onCancel();
    expect(client.events).toContainEvent("cancelled");
  });

  test("onReset clears state and emits reset event", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();
    session.onReset();
    expect(client.events).toContainEvent("reset");
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("onHistory appends messages to conversation", async () => {
    const { session } = setup();
    await session.start();
    session.onHistory([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    // No error — messages stored internally
  });

  test("waitForTurn resolves immediately when no turn in progress", async () => {
    const { session } = setup();
    await session.start();
    await expect(session.waitForTurn()).resolves.toBeUndefined();
  });

  // ─── S2S event handling tests ───────────────────────────────────────────

  test("user_transcript event emits user_transcript", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("event", { type: "user_transcript", text: "Hello there" });
    await flush();

    expect(client.events).toContainEvent("user_transcript", { text: "Hello there" });
  });

  test("audio event forwards audio to client", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    const chunk = new Uint8Array([10, 20, 30]);
    mockHandle._fire("audio", { audio: chunk });

    expect(client.audioChunks).toContainEqual(chunk);
  });

  test("agent_transcript emits agent_transcript", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("event", {
      type: "agent_transcript",
      text: "Full response",
      _interrupted: false,
    });

    expect(client.events).toContainEvent("agent_transcript", { text: "Full response" });
  });

  test("speech_started and speech_stopped events are forwarded", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("event", { type: "speech_started" });
    mockHandle._fire("event", { type: "speech_stopped" });

    expect(client.events).toContainEvent("speech_started");
    expect(client.events).toContainEvent("speech_stopped");
  });

  test("reply_started resets tool call count", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    // No error — internal counter reset
  });

  test("reply_done without pending tools calls playAudioDone", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("event", { type: "reply_done" });

    expect(client.audioDoneCount).toBe(1);
    expect(client.events).toContainEvent("reply_done");
  });

  test("cancelled event emits cancelled", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("event", { type: "cancelled" });

    expect(client.events).toContainEvent("cancelled");
  });

  test("error event emits error to client and closes handle", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("error", new Error("Something broke"));

    expect(client.events).toContainEvent("error", { code: "internal", message: "Something broke" });
    expect(mockHandle.close).toHaveBeenCalled();
  });

  // ─── Tool call handling ────────────────────────────────────────────────

  test("tool_call executes tool and accumulates pending result", async () => {
    const executeTool = vi.fn(async () => "tool-output");
    const { session, client, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire(
      "event",
      buildClientEvent("tool_call", {
        toolCallId: "call-1",
        toolName: "my_tool",
        args: { key: "value" },
      }),
    );

    // Wait for async tool execution
    await session.waitForTurn();

    expect(executeTool).toHaveBeenCalledWith(
      "my_tool",
      { key: "value" },
      "session-1",
      expect.any(Array),
    );
    expect(client.events).toContainEvent("tool_call", {
      toolCallId: "call-1",
      toolName: "my_tool",
      args: { key: "value" },
    });
    expect(client.events).toContainEvent("tool_call_done", {
      toolCallId: "call-1",
      result: "tool-output",
    });
  });

  test("tool_call batches result and sends on reply_done", async () => {
    const executeTool = vi.fn(async () => "result-1");
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c1", toolName: "t1" }));
    await session.waitForTurn();

    // Result not sent yet — S2S protocol requires waiting for reply_done
    expect(mockHandle.sendToolResult).not.toHaveBeenCalled();

    mockHandle._fire("event", { type: "reply_done" });
    // reply_done waits for turnPromise then sends
    await vi.waitFor(() => {
      expect(mockHandle.sendToolResult).toHaveBeenCalledWith("c1", "result-1");
    });
  });

  test("tool execution error returns JSON error string", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("boom");
    });
    const { session, client, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c1", toolName: "t1" }));
    await session.waitForTurn();

    const doneEvent = client.events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev.type === "tool_call_done" && ev.toolCallId === "c1";
    }) as Record<string, unknown>;
    expect(doneEvent.result).toBe(JSON.stringify({ error: "boom" }));
  });

  test("consumeToolCallStep refuses tool when maxSteps exceeded", async () => {
    const executeTool = vi.fn(async () => "ok");
    const { session, client, mockHandle } = setup({
      executeTool,
      agentConfig: {
        name: "test-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hello!",
        maxSteps: 1,
      },
    });
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    // First tool call — should succeed (count goes to 1, which equals maxSteps)
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c1", toolName: "t1" }));
    await session.waitForTurn();

    // Second tool call — should be refused (count goes to 2 > maxSteps 1)
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c2", toolName: "t2" }));
    await session.waitForTurn();

    const doneEvent = client.events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev.type === "tool_call_done" && ev.toolCallId === "c2";
    }) as Record<string, unknown>;
    expect(doneEvent.result).toContain("Maximum tool steps reached");
    // executeTool should only be called for the first one
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  // ─── connectS2s failure ────────────────────────────────────────────────

  test("start() handles connectS2s failure gracefully", async () => {
    makeMockHandle();
    const spy = vi.spyOn(_internals, "connectS2s").mockRejectedValue(new Error("connect failed"));
    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client }));

    await session.start();

    expect(client.events).toContainEvent("error", { code: "internal", message: "connect failed" });

    spy.mockRestore();
  });

  // ─── Concurrency bug regression tests ─────────────────────────────────

  test("barge-in prevents in-flight tool results from being sent", async () => {
    let resolveToolCall!: (value: string) => void;
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveToolCall = r;
        }),
    );
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    // Start a tool call (stays pending)
    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c1", toolName: "t1" }));

    // Wait for executeTool to be called (handleToolCall has async steps before it)
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());

    // Barge-in before tool completes — invalidates currentReplyId
    mockHandle._fire("event", buildClientEvent("cancelled"));

    // Now the tool finishes — its result should be discarded (generation mismatch)
    resolveToolCall("late-result");
    await session.waitForTurn();

    // Start new reply and trigger reply_done — stale result must not leak
    mockHandle._fire("replyStarted", { replyId: "r2" });
    mockHandle._fire("event", { type: "reply_done" });

    expect(mockHandle.sendToolResult).not.toHaveBeenCalled();
  });

  test("reply_done waits for slow tool calls before sending results", async () => {
    let resolveToolCall!: (value: string) => void;
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveToolCall = r;
        }),
    );
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c1", toolName: "t1" }));

    // Wait for executeTool to be called
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());

    // reply_done fires while tool is still executing
    mockHandle._fire("event", buildClientEvent("reply_done"));

    // Result not sent yet — tool still running
    expect(mockHandle.sendToolResult).not.toHaveBeenCalled();

    // Tool finishes — reply_done's deferred handler should now send it
    resolveToolCall("result-1");
    await vi.waitFor(() => {
      expect(mockHandle.sendToolResult).toHaveBeenCalledWith("c1", "result-1");
    });
  });

  test("stale tool results from interrupted reply don't leak into next reply", async () => {
    let resolveToolCall!: (value: string) => void;
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveToolCall = r;
        }),
    );
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    // First reply — interrupted while tool is running
    mockHandle._fire("replyStarted", { replyId: "r1" });
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c1", toolName: "t1" }));
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    mockHandle._fire("event", buildClientEvent("cancelled"));

    // Tool from first reply finishes late
    resolveToolCall("stale-result");
    await session.waitForTurn();

    // Second reply has its own tool call
    executeTool.mockImplementation(async () => "fresh-result");
    mockHandle._fire("replyStarted", { replyId: "r2" });
    mockHandle._fire("event", buildClientEvent("tool_call", { toolCallId: "c2", toolName: "t2" }));
    await session.waitForTurn();
    mockHandle._fire("event", buildClientEvent("reply_done"));

    // Only the fresh result should be sent, not the stale one
    await vi.waitFor(() => {
      expect(mockHandle.sendToolResult).toHaveBeenCalledTimes(1);
    });
    expect(mockHandle.sendToolResult).toHaveBeenCalledWith("c2", "fresh-result");
  });

  test("stop() during start() closes S2S handle to prevent orphaned connection", async () => {
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
    // Stop before connect completes
    const stopPromise = session.stop();

    // Now connect completes — handle should be closed immediately
    resolveConnect(handle);
    await startPromise;
    await stopPromise;

    expect(handle.close).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("rapid onReset closes stale connections from earlier resets", async () => {
    // Simulate three rapid resets where connectS2s resolves in reverse order.
    // Only the last connection should be kept; earlier ones should be closed.
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

    // Initial start — creates first pending connection
    const startPromise = session.start();

    // Two rapid resets before initial connect completes
    session.onReset();
    session.onReset();

    // We now have 3 pending connectS2s calls (1 from start + 2 from resets).
    // Resolve them in order: first two are stale, third is current.
    expect(resolvers.length).toBe(3);

    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    resolvers[0]?.(handles[0]!);
    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    resolvers[1]?.(handles[1]!);
    // biome-ignore lint/style/noNonNullAssertion: test assertions after length check
    resolvers[2]?.(handles[2]!);

    await startPromise;
    await flush();

    // First two handles should be closed (stale generations)
    expect(handles[0]?.close).toHaveBeenCalled();
    expect(handles[1]?.close).toHaveBeenCalled();
    // Third handle (most recent) should NOT be closed — it's the active one
    expect(handles[2]?.close).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  // ─── Idle timeout tests ──────────────────────────────────────────────

  test("idle timeout fires after configured period of inactivity", async () => {
    vi.useFakeTimers();
    const { session, client, mockHandle } = setup({
      agentConfig: {
        name: "test-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hello!",
        idleTimeoutMs: 10_000,
      },
    });
    await session.start();
    vi.advanceTimersByTime(10_000);
    expect(client.events).toContainEvent("idle_timeout");
    expect(mockHandle.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("idle timeout is reset by client audio", async () => {
    vi.useFakeTimers();
    const { session, client } = setup({
      agentConfig: {
        name: "test-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hello!",
        idleTimeoutMs: 10_000,
      },
    });
    await session.start();
    vi.advanceTimersByTime(8000);
    session.onAudio(new Uint8Array([1, 2, 3]));
    vi.advanceTimersByTime(8000);
    expect(client.events).not.toContainEvent("idle_timeout");
    vi.advanceTimersByTime(2000);
    expect(client.events).toContainEvent("idle_timeout");
    vi.useRealTimers();
  });

  test("idle timeout disabled when idleTimeoutMs is 0", async () => {
    vi.useFakeTimers();
    const { session, client } = setup({
      agentConfig: {
        name: "test-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hello!",
        idleTimeoutMs: 0,
      },
    });
    await session.start();
    vi.advanceTimersByTime(600_000);
    expect(client.events).not.toContainEvent("idle_timeout");
    vi.useRealTimers();
  });

  test("idle timer is cleared on stop()", async () => {
    vi.useFakeTimers();
    const { session, client } = setup({
      agentConfig: {
        name: "test-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        greeting: "Hello!",
        idleTimeoutMs: 10_000,
      },
    });
    await session.start();
    await session.stop();
    vi.advanceTimersByTime(20_000);
    expect(client.events).not.toContainEvent("idle_timeout");
    vi.useRealTimers();
  });

  test("default idle timeout is 5 minutes when not configured", async () => {
    vi.useFakeTimers();
    const { session, client } = setup();
    await session.start();
    vi.advanceTimersByTime(240_000);
    expect(client.events).not.toContainEvent("idle_timeout");
    vi.advanceTimersByTime(60_000);
    expect(client.events).toContainEvent("idle_timeout");
    vi.useRealTimers();
  });
});
