import { createNanoEvents } from "nanoevents";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeConfig } from "./_test-utils.ts";
import { type ClientSink, HOOK_TIMEOUT_MS } from "./protocol.ts";
import type { S2sEvents, S2sHandle } from "./s2s.ts";
import { _internals, buildSystemPrompt, createS2sSession, type SessionOptions } from "./session.ts";
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

// ─── buildSystemPrompt tests (existing) ─────────────────────────────────────

describe("buildSystemPrompt", () => {
  test("starts with DEFAULT_INSTRUCTIONS when no custom instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result.startsWith(DEFAULT_INSTRUCTIONS)).toBe(true);
  });

  test("does not include agent-specific instructions section for default instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("Agent-Specific Instructions:");
  });

  test("appends custom agent instructions", () => {
    const custom = "You are a pirate. Always speak like one.";
    const result = buildSystemPrompt(makeConfig({ instructions: custom }), { hasTools: false });
    expect(result).toContain("Agent-Specific Instructions:");
    expect(result).toContain(custom);
  });

  test("includes tool preamble when hasTools is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });

  test("omits tool preamble when hasTools is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });

  test("appends voice rules when voice is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("NEVER use markdown");
  });

  test("omits voice rules when voice is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("omits voice rules when voice is undefined", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("includes today's date", () => {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain(`Today's date is ${today}.`);
  });

  test("voice + hasTools includes both voice rules and tool preamble", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true, voice: true });
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });

  test("custom instructions + voice + tools includes all sections", () => {
    const result = buildSystemPrompt(makeConfig({ instructions: "Be concise." }), {
      hasTools: true,
      voice: true,
    });
    expect(result).toContain("Agent-Specific Instructions:");
    expect(result).toContain("Be concise.");
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });
});

// ─── createS2sSession tests ─────────────────────────────────────────────────

/** Create a mock S2sHandle backed by nanoevents. */
function makeMockHandle(): S2sHandle & {
  _fire: <K extends keyof S2sEvents>(type: K, ...args: Parameters<S2sEvents[K]>) => void;
} {
  const emitter = createNanoEvents<S2sEvents>();
  return {
    on: emitter.on.bind(emitter),
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
    _fire<K extends keyof S2sEvents>(type: K, ...args: Parameters<S2sEvents[K]>) {
      emitter.emit(type, ...args);
    },
  };
}

function makeClient(): ClientSink & {
  events: unknown[];
  audioChunks: Uint8Array[];
  audioDoneCount: number;
} {
  const events: unknown[] = [];
  const audioChunks: Uint8Array[] = [];
  let audioDoneCount = 0;
  return {
    open: true,
    events,
    audioChunks,
    get audioDoneCount() {
      return audioDoneCount;
    },
    event(e) {
      events.push(e);
    },
    playAudioChunk(chunk) {
      audioChunks.push(chunk);
    },
    playAudioDone() {
      audioDoneCount++;
    },
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeSessionOpts(overrides?: Partial<SessionOptions>): SessionOptions {
  return {
    id: "session-1",
    agent: "test-agent",
    client: makeClient(),
    agentConfig: {
      name: "test-agent",
      instructions: DEFAULT_INSTRUCTIONS,
      greeting: "Hello!",
    },
    toolSchemas: [],
    apiKey: "test-key",
    s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
    executeTool: vi.fn(async () => "tool-result"),
    createWebSocket: vi.fn(),
    logger: silentLogger,
    ...overrides,
  };
}

describe("createS2sSession", () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  let mockHandle: ReturnType<typeof makeMockHandle>;

  function setup(overrides?: Partial<SessionOptions>) {
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

  test("start() calls connectS2s and invokes onConnect hook", async () => {
    const onConnect = vi.fn();
    const hookInvoker = {
      onConnect,
      onDisconnect: vi.fn(),
      onTurn: vi.fn(),
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => null),
    };
    const { session } = setup({ hookInvoker });

    await session.start();
    expect(connectSpy).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledWith("session-1", HOOK_TIMEOUT_MS);
  });

  test("start() sends updateSession with greeting on initial connect", async () => {
    const { session, mockHandle } = setup();
    await session.start();
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
    const arg = vi.mocked(mockHandle.updateSession).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg?.greeting).toBe("Hello!");
    expect(arg?.system_prompt).toContain(DEFAULT_INSTRUCTIONS);
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

  test("stop() invokes onDisconnect hook", async () => {
    const onDisconnect = vi.fn();
    const hookInvoker = {
      onConnect: vi.fn(),
      onDisconnect,
      onTurn: vi.fn(),
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => null),
    };
    const { session } = setup({ hookInvoker });
    await session.start();
    await session.stop();
    expect(onDisconnect).toHaveBeenCalledWith("session-1", HOOK_TIMEOUT_MS);
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
    expect(
      client.events.some((e: unknown) => (e as Record<string, unknown>).type === "cancelled"),
    ).toBe(true);
  });

  test("onReset clears state and emits reset event", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();
    session.onReset();
    expect(
      client.events.some((e: unknown) => (e as Record<string, unknown>).type === "reset"),
    ).toBe(true);
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("onHistory appends messages to conversation", async () => {
    const { session } = setup();
    await session.start();
    session.onHistory([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ]);
    // No error — messages stored internally
  });

  test("waitForTurn resolves immediately when no turn in progress", async () => {
    const { session } = setup();
    await session.start();
    await expect(session.waitForTurn()).resolves.toBeUndefined();
  });

  // ─── S2S event handling tests ───────────────────────────────────────────

  test("user_transcript event emits transcript and turn events", async () => {
    const onTurn = vi.fn();
    const hookInvoker = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onTurn,
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => null),
    };
    const { session, client, mockHandle } = setup({ hookInvoker });
    await session.start();

    mockHandle._fire("user_transcript", { item_id: "item-1", text: "Hello there" });

    expect(client.events).toContainEqual({
      type: "transcript",
      text: "Hello there",
      isFinal: true,
    });
    expect(client.events).toContainEqual({ type: "turn", text: "Hello there" });
    expect(onTurn).toHaveBeenCalledWith("session-1", "Hello there", HOOK_TIMEOUT_MS);
  });

  test("user_transcript_delta emits non-final transcript", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("user_transcript_delta", { text: "Hel" });

    expect(client.events).toContainEqual({
      type: "transcript",
      text: "Hel",
      isFinal: false,
    });
  });

  test("audio event forwards audio to client", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    const chunk = new Uint8Array([10, 20, 30]);
    mockHandle._fire("audio", { audio: chunk });

    expect(client.audioChunks).toContainEqual(chunk);
  });

  test("agent_transcript_delta emits chat_delta", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("agent_transcript_delta", { text: "I think" });

    expect(client.events).toContainEqual({ type: "chat_delta", text: "I think" });
  });

  test("agent_transcript emits chat event", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("agent_transcript", { text: "Full response" });

    expect(client.events).toContainEqual({ type: "chat", text: "Full response" });
  });

  test("speech_started and speech_stopped events are forwarded", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("speech_started");
    mockHandle._fire("speech_stopped");

    expect(client.events).toContainEqual({ type: "speech_started" });
    expect(client.events).toContainEqual({ type: "speech_stopped" });
  });

  test("reply_started resets tool call count", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    mockHandle._fire("reply_started", { reply_id: "r1" });
    // No error — internal counter reset
  });

  test("reply_done without pending tools calls playAudioDone", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("reply_done", { status: "completed" });

    expect(client.audioDoneCount).toBe(1);
    expect(client.events).toContainEqual({ type: "tts_done" });
  });

  test("reply_done with interrupted status emits cancelled", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("reply_done", { status: "interrupted" });

    expect(client.events).toContainEqual({ type: "cancelled" });
  });

  test("error event emits error to client and closes handle", async () => {
    const { session, client, mockHandle } = setup();
    await session.start();

    mockHandle._fire("error", { code: "test_error", message: "Something broke" });

    expect(client.events).toContainEqual({
      type: "error",
      code: "internal",
      message: "Something broke",
    });
    expect(mockHandle.close).toHaveBeenCalled();
  });

  // ─── Tool call handling ────────────────────────────────────────────────

  test("tool_call executes tool and accumulates pending result", async () => {
    const executeTool = vi.fn(async () => "tool-output");
    const { session, client, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("tool_call", {
      call_id: "call-1",
      name: "my_tool",
      args: { key: "value" },
    });

    // Wait for async tool execution
    await session.waitForTurn();

    expect(executeTool).toHaveBeenCalledWith(
      "my_tool",
      { key: "value" },
      "session-1",
      expect.any(Array),
    );
    expect(client.events).toContainEqual({
      type: "tool_call_start",
      toolCallId: "call-1",
      toolName: "my_tool",
      args: { key: "value" },
    });
    expect(client.events).toContainEqual({
      type: "tool_call_done",
      toolCallId: "call-1",
      result: "tool-output",
    });
  });

  test("tool_call batches result and sends on reply_done", async () => {
    const executeTool = vi.fn(async () => "result-1");
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await session.waitForTurn();

    // Result not sent yet — S2S protocol requires waiting for reply_done
    expect(mockHandle.sendToolResult).not.toHaveBeenCalled();

    mockHandle._fire("reply_done", { status: "completed" });
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

    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await session.waitForTurn();

    const doneEvent = client.events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev.type === "tool_call_done" && ev.toolCallId === "c1";
    }) as Record<string, unknown>;
    expect(doneEvent.result).toBe(JSON.stringify({ error: "boom" }));
  });

  test("checkTurnLimits refuses tool when maxSteps exceeded", async () => {
    const executeTool = vi.fn(async () => "ok");
    const hookInvoker = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onTurn: vi.fn(),
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => ({ maxSteps: 1 })),
    };
    const { session, client, mockHandle } = setup({ executeTool, hookInvoker });
    await session.start();

    // First tool call — should succeed (count goes to 1, which equals maxSteps)
    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await session.waitForTurn();

    // Second tool call — should be refused (count goes to 2 > maxSteps 1)
    mockHandle._fire("tool_call", { call_id: "c2", name: "t2", args: {} });
    await session.waitForTurn();

    const doneEvent = client.events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev.type === "tool_call_done" && ev.toolCallId === "c2";
    }) as Record<string, unknown>;
    expect(doneEvent.result).toContain("Maximum tool steps reached");
    // executeTool should only be called for the first one
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  test("checkTurnLimits refuses tool not in activeTools", async () => {
    const executeTool = vi.fn(async () => "ok");
    const hookInvoker = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onTurn: vi.fn(),
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => ({ activeTools: ["allowed_tool"] })),
    };
    const { session, client, mockHandle } = setup({ executeTool, hookInvoker });
    await session.start();

    mockHandle._fire("tool_call", { call_id: "c1", name: "blocked_tool", args: {} });
    await session.waitForTurn();

    const doneEvent = client.events.find((e) => {
      const ev = e as Record<string, unknown>;
      return ev.type === "tool_call_done" && ev.toolCallId === "c1";
    }) as Record<string, unknown>;
    expect(doneEvent.result).toContain("not available");
    expect(executeTool).not.toHaveBeenCalled();
  });

  // ─── connectS2s failure ────────────────────────────────────────────────

  test("start() handles connectS2s failure gracefully", async () => {
    makeMockHandle();
    const spy = vi.spyOn(_internals, "connectS2s").mockRejectedValue(new Error("connect failed"));
    const client = makeClient();
    const session = createS2sSession(makeSessionOpts({ client }));

    await session.start();

    expect(client.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "internal",
        message: "connect failed",
      }),
    );

    spy.mockRestore();
  });

  // ─── Hook error handling ───────────────────────────────────────────────

  test("hook failure does not crash session", async () => {
    const hookInvoker = {
      onConnect: vi.fn(() => {
        throw new Error("hook error");
      }),
      onDisconnect: vi.fn(),
      onTurn: vi.fn(),
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => null),
    };
    const { session } = setup({ hookInvoker });

    // invokeHook catches errors, so this should not throw
    await session.start();
    // Give time for async hook to settle
    await new Promise((r) => setTimeout(r, 10));
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
    mockHandle._fire("reply_started", { reply_id: "r1" });
    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });

    // Wait for executeTool to be called (handleToolCall has async steps before it)
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());

    // Barge-in before tool completes — bumps replyGeneration
    mockHandle._fire("reply_done", { status: "interrupted" });

    // Now the tool finishes — its result should be discarded (generation mismatch)
    resolveToolCall("late-result");
    await session.waitForTurn();

    // Start new reply and trigger reply_done — stale result must not leak
    mockHandle._fire("reply_started", { reply_id: "r2" });
    mockHandle._fire("reply_done", { status: "completed" });

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

    mockHandle._fire("reply_started", { reply_id: "r1" });
    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });

    // Wait for executeTool to be called
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());

    // reply_done fires while tool is still executing
    mockHandle._fire("reply_done", { status: "completed" });

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
    mockHandle._fire("reply_started", { reply_id: "r1" });
    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    mockHandle._fire("reply_done", { status: "interrupted" });

    // Tool from first reply finishes late
    resolveToolCall("stale-result");
    await session.waitForTurn();

    // Second reply has its own tool call
    executeTool.mockImplementation(async () => "fresh-result");
    mockHandle._fire("reply_started", { reply_id: "r2" });
    mockHandle._fire("tool_call", { call_id: "c2", name: "t2", args: {} });
    await session.waitForTurn();
    mockHandle._fire("reply_done", { status: "completed" });

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

  test("resolveTurnConfig failure returns error and skips tool execution", async () => {
    const hookInvoker = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onTurn: vi.fn(),
      onError: vi.fn(),
      onStep: vi.fn(),
      resolveTurnConfig: vi.fn(async () => {
        throw new Error("config error");
      }),
    };
    const executeTool = vi.fn(async () => "ok");
    const { session, mockHandle, client } = setup({ hookInvoker, executeTool });
    await session.start();

    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await session.waitForTurn();

    // executeTool should NOT be called — resolveTurnConfig failure short-circuits
    expect(executeTool).not.toHaveBeenCalled();
    // Client should receive tool_call_done with error message
    const doneEvent = client.events.find(
      (e) =>
        (e as Record<string, unknown>).type === "tool_call_done" &&
        (e as Record<string, unknown>).toolCallId === "c1",
    ) as Record<string, unknown> | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.result).toContain("resolveTurnConfig hook error");
  });
});
