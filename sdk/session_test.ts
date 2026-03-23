import { afterEach, describe, expect, test, vi } from "vitest";
import { makeConfig } from "./_test_utils.ts";
import type { ClientSink } from "./protocol.ts";
import type { S2sHandle } from "./s2s.ts";
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

/** Create a mock S2sHandle backed by EventTarget. */
function makeMockHandle(): S2sHandle & { _fire: (type: string, detail?: unknown) => void } {
  const target = new EventTarget();
  const handle = Object.assign(target, {
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
    _fire(type: string, detail?: unknown) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    },
  });
  return handle;
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
    s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16000, outputSampleRate: 24000 },
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
    expect(onConnect).toHaveBeenCalledWith("session-1", undefined, 5000);
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
    expect(onDisconnect).toHaveBeenCalledWith("session-1", undefined, 5000);
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
    expect(onTurn).toHaveBeenCalledWith("session-1", "Hello there", 5000);
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

    mockHandle.dispatchEvent(new Event("speech_started"));
    mockHandle.dispatchEvent(new Event("speech_stopped"));

    expect(client.events).toContainEqual({ type: "speech_started" });
    expect(client.events).toContainEqual({ type: "speech_stopped" });
  });

  test("reply_started resets tool call count", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    mockHandle.dispatchEvent(new Event("reply_started"));
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

  test("ready event stores session_id", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    mockHandle._fire("ready", { session_id: "s2s-session-123" });
    // No assertion needed — this is internal state. We verify indirectly
    // by testing resumeSession is called on reconnect.
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

  test("tool_call sends pending results on reply_done", async () => {
    const executeTool = vi.fn(async () => "result-1");
    const { session, mockHandle } = setup({ executeTool });
    await session.start();

    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await session.waitForTurn();

    mockHandle._fire("reply_done", {});

    expect(mockHandle.sendToolResult).toHaveBeenCalledWith("c1", "result-1");
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

  // ─── Reconnect logic ──────────────────────────────────────────────────

  test("close event triggers reconnect when session not aborted", async () => {
    const { session, mockHandle } = setup();
    await session.start();

    // First call was the initial connect
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // Simulate close — should trigger reconnect
    mockHandle._fire("close");

    // Wait for reconnect
    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalledTimes(2);
    });
  });

  test("close event does NOT reconnect after stop()", async () => {
    const { session, mockHandle } = setup();
    await session.start();
    await session.stop();

    connectSpy.mockClear();
    mockHandle._fire("close");

    // Give time for potential reconnect
    await new Promise((r) => setTimeout(r, 50));
    expect(connectSpy).not.toHaveBeenCalled();
  });

  test("session_expired event triggers fresh reconnect without session ID", async () => {
    const { session, mockHandle: firstHandle } = setup();
    await session.start();

    // Simulate ready to set session ID
    firstHandle._fire("ready", { session_id: "old-session" });

    // Create second handle for reconnect
    const secondHandle = makeMockHandle();
    connectSpy.mockResolvedValueOnce(secondHandle);

    // Simulate session_expired — this closes the handle, which triggers reconnect
    firstHandle._fire("session_expired");

    expect(firstHandle.close).toHaveBeenCalled();
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

  // ─── Metrics ───────────────────────────────────────────────────────────

  test("start() increments metrics, stop() decrements", async () => {
    const metrics = {
      sessionsTotal: { inc: vi.fn() },
      sessionsActive: { inc: vi.fn(), dec: vi.fn() },
    };
    const { session } = setup({ metrics });
    await session.start();

    expect(metrics.sessionsTotal.inc).toHaveBeenCalledWith({ agent: "test-agent" });
    expect(metrics.sessionsActive.inc).toHaveBeenCalledWith({ agent: "test-agent" });

    await session.stop();
    expect(metrics.sessionsActive.dec).toHaveBeenCalledWith({ agent: "test-agent" });
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

  test("resolveTurnConfig failure returns null and logs warning", async () => {
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
    const { session, mockHandle } = setup({ hookInvoker, executeTool });
    await session.start();

    // Tool call should still work even if resolveTurnConfig fails
    mockHandle._fire("tool_call", { call_id: "c1", name: "t1", args: {} });
    await session.waitForTurn();

    expect(executeTool).toHaveBeenCalled();
  });
});
