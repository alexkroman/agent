import { afterEach, describe, expect, test, vi } from "vitest";
import { handleToolCall, setupListeners } from "./_session-otel.ts";
import { makeClient, makeMockHandle, silentLogger } from "./_test-utils.ts";
import { MAX_TOOL_RESULT_CHARS } from "./constants.ts";
import type { HookInvoker } from "./middleware.ts";
import type { S2sToolCall } from "./s2s.ts";
import type { S2sSessionCtx } from "./session.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHook(overrides?: Partial<HookInvoker>): HookInvoker {
  return {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onTurn: vi.fn(),
    onError: vi.fn(),
    resolveTurnConfig: vi.fn(async () => null),
    ...overrides,
  } as HookInvoker;
}

function makeCtx(overrides?: Partial<S2sSessionCtx>): S2sSessionCtx {
  const conversationMessages = overrides?.conversationMessages ?? [];
  const reply = {
    pendingTools: [] as { callId: string; result: string }[],
    toolCallCount: 0,
    currentReplyId: "r0" as string | null,
    ...overrides?.reply,
  };
  const ctx: Record<string, unknown> = {
    id: "session-1",
    agent: "test-agent",
    client: makeClient(),
    agentConfig: { name: "test-agent", instructions: "", greeting: "Hi" },
    executeTool: vi.fn(async () => "tool-result"),
    hookInvoker: undefined,
    log: silentLogger,
    s2s: null,
    turnPromise: null,
    conversationMessages,
    maxHistory: 200,
    filterChain: Promise.resolve(),
    resolveTurnConfig: vi.fn(async () => null),
    consumeToolCallStep: vi.fn(() => null),
    pushMessages: vi.fn((...msgs: unknown[]) => conversationMessages.push(...(msgs as never[]))),
    fireHook: vi.fn(),
    beginReply(replyId: string) {
      (ctx as unknown as S2sSessionCtx).reply = {
        pendingTools: [],
        toolCallCount: 0,
        currentReplyId: replyId,
      };
      ctx.turnPromise = null;
      ctx.filterChain = Promise.resolve();
    },
    cancelReply() {
      (ctx as unknown as S2sSessionCtx).reply = {
        pendingTools: [],
        toolCallCount: 0,
        currentReplyId: null,
      };
      ctx.filterChain = Promise.resolve();
    },
    chainTurn(p: Promise<void>) {
      ctx.turnPromise = ((ctx.turnPromise as Promise<void> | null) ?? Promise.resolve()).then(
        () => p,
      );
    },
    ...{ ...overrides, reply },
  };
  return ctx as unknown as S2sSessionCtx;
}

const tc = (o?: Partial<S2sToolCall>): S2sToolCall => ({
  callId: "call-1",
  name: "myTool",
  args: { foo: "bar" },
  ...o,
});

type ClientWithEvents = { events: Record<string, unknown>[] };

function findEvent(ctx: S2sSessionCtx, type: string) {
  return (ctx.client as unknown as ClientWithEvents).events.find((e) => e.type === type);
}

function allEvents(ctx: S2sSessionCtx) {
  return (ctx.client as unknown as ClientWithEvents).events;
}

// ─── handleToolCall ──────────────────────────────────────────────────────────

describe("handleToolCall", () => {
  afterEach(() => vi.restoreAllMocks());

  test("normal execution: calls executeTool, emits events, pushes pendingTools", async () => {
    const ctx = makeCtx();
    await handleToolCall(ctx, tc());
    expect(ctx.executeTool).toHaveBeenCalledWith(
      "myTool",
      { foo: "bar" },
      "session-1",
      ctx.conversationMessages,
    );
    expect(findEvent(ctx, "tool_call_start")).toMatchObject({
      toolCallId: "call-1",
      toolName: "myTool",
    });
    expect(findEvent(ctx, "tool_call_done")).toMatchObject({
      toolCallId: "call-1",
      result: "tool-result",
    });
    expect(ctx.reply.pendingTools).toEqual([{ callId: "call-1", result: "tool-result" }]);
  });

  test("resolveTurnConfig error: returns error without executing", async () => {
    const ctx = makeCtx({
      resolveTurnConfig: vi.fn(async () => {
        throw new Error("config boom");
      }),
    } as Partial<S2sSessionCtx>);
    await handleToolCall(ctx, tc());
    expect(ctx.executeTool).not.toHaveBeenCalled();
    const result = JSON.parse(findEvent(ctx, "tool_call_done")?.result as string);
    expect(result.error).toContain("resolveTurnConfig hook error");
  });

  test("refused tool call: returns refusal without executing", async () => {
    const ctx = makeCtx({
      consumeToolCallStep: vi.fn(() => JSON.stringify({ error: "Tool not allowed" })),
    } as Partial<S2sSessionCtx>);
    await handleToolCall(ctx, tc());
    expect(ctx.executeTool).not.toHaveBeenCalled();
    expect(findEvent(ctx, "tool_call_done")?.result).toBe(
      JSON.stringify({ error: "Tool not allowed" }),
    );
  });

  test("middleware block: returns error JSON without executing", async () => {
    const ctx = makeCtx({
      hookInvoker: makeHook({
        interceptToolCall: vi.fn(async () => ({ type: "block" as const, reason: "blocked!" })),
      }),
    });
    await handleToolCall(ctx, tc());
    expect(ctx.executeTool).not.toHaveBeenCalled();
    expect(findEvent(ctx, "tool_call_done")?.result).toBe(JSON.stringify({ error: "blocked!" }));
  });

  test("middleware cached result: returns cached value and fires afterToolCall", async () => {
    const ctx = makeCtx({
      hookInvoker: makeHook({
        interceptToolCall: vi.fn(async () => ({ type: "result" as const, result: "cached" })),
        afterToolCall: vi.fn(async () => undefined),
      }),
    });
    await handleToolCall(ctx, tc());
    expect(ctx.executeTool).not.toHaveBeenCalled();
    expect(findEvent(ctx, "tool_call_done")?.result).toBe("cached");
    expect(ctx.fireHook).toHaveBeenCalledWith("afterToolCall", expect.any(Function));
  });

  test("middleware arg transform: passes modified args to executeTool", async () => {
    const ctx = makeCtx({
      hookInvoker: makeHook({
        interceptToolCall: vi.fn(async () => ({ type: "args" as const, args: { modified: true } })),
      }),
    });
    await handleToolCall(ctx, tc());
    expect(ctx.executeTool).toHaveBeenCalledWith(
      "myTool",
      { modified: true },
      "session-1",
      ctx.conversationMessages,
    );
  });

  test("execution error: logs error and returns JSON error", async () => {
    const ctx = makeCtx({
      executeTool: vi.fn(async () => {
        throw new Error("exec fail");
      }),
    } as Partial<S2sSessionCtx>);
    await handleToolCall(ctx, tc());
    expect(ctx.log.error).toHaveBeenCalledWith("Tool execution failed", expect.any(Object));
    expect(findEvent(ctx, "tool_call_done")?.result).toBe(JSON.stringify({ error: "exec fail" }));
    expect(ctx.reply.pendingTools).toHaveLength(1);
  });

  test("stale reply: discards result from pendingTools", async () => {
    const ctx = makeCtx({
      reply: { pendingTools: [], toolCallCount: 0, currentReplyId: "r1" },
      executeTool: vi.fn(async () => {
        ctx.reply.currentReplyId = "r2";
        return "stale";
      }),
    });
    await handleToolCall(ctx, tc());
    expect(ctx.reply.pendingTools).toEqual([]);
    expect(findEvent(ctx, "tool_call_done")).toBeDefined();
  });

  test("result truncation at MAX_TOOL_RESULT_CHARS", async () => {
    const ctx = makeCtx({
      executeTool: vi.fn(async () => "x".repeat(MAX_TOOL_RESULT_CHARS + 100)),
    } as Partial<S2sSessionCtx>);
    await handleToolCall(ctx, tc());
    expect(findEvent(ctx, "tool_call_done")?.result as string).toHaveLength(MAX_TOOL_RESULT_CHARS);
  });

  test("interceptToolCall error: logs warning and still executes tool", async () => {
    const ctx = makeCtx({
      hookInvoker: makeHook({
        interceptToolCall: vi.fn(async () => {
          throw new Error("middleware broke");
        }),
      }),
    });
    await handleToolCall(ctx, tc());
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "interceptToolCall middleware failed (fail-open, tool call proceeds)",
      expect.objectContaining({ err: "middleware broke", tool: "myTool" }),
    );
    expect(ctx.executeTool).toHaveBeenCalled();
  });
});

// ─── setupListeners ──────────────────────────────────────────────────────────

describe("setupListeners", () => {
  afterEach(() => vi.restoreAllMocks());

  test("reply_started resets state and sets currentReplyId", () => {
    const ctx = makeCtx({
      reply: {
        toolCallCount: 5,
        currentReplyId: "old-reply",
        pendingTools: [{ callId: "x", result: "y" }],
      },
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyStarted", { replyId: "r1" });
    expect(ctx.reply.toolCallCount).toBe(0);
    expect(ctx.reply.currentReplyId).toBe("r1");
    expect(ctx.reply.pendingTools).toEqual([]);
  });

  test("reply_done interrupted: nullifies currentReplyId and emits cancelled", () => {
    const ctx = makeCtx({ reply: { pendingTools: [], toolCallCount: 0, currentReplyId: "r1" } });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "interrupted" });
    expect(ctx.reply.currentReplyId).toBeNull();
    expect(ctx.reply.pendingTools).toEqual([]);
    expect(allEvents(ctx)).toContainEqual({ type: "cancelled" });
  });

  test("reply_done with pending tools: sends tool results via s2s", () => {
    const s2s = makeMockHandle();
    const ctx = makeCtx({
      s2s,
      reply: {
        pendingTools: [{ callId: "c1", result: "r1" }],
        toolCallCount: 0,
        currentReplyId: "r0",
      },
      turnPromise: null,
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "done" });
    expect(s2s.sendToolResult).toHaveBeenCalledWith("c1", "r1");
    expect(ctx.reply.pendingTools).toEqual([]);
  });

  test("reply_done without pending tools: emits tts_done", () => {
    const ctx = makeCtx({
      reply: { pendingTools: [], toolCallCount: 0, currentReplyId: "r0" },
      turnPromise: null,
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "done" });
    expect(allEvents(ctx)).toContainEqual({ type: "tts_done" });
  });

  test("reply_done with turnPromise: waits before sending pending", async () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });
    const s2s = makeMockHandle();
    const ctx = makeCtx({
      s2s,
      reply: {
        pendingTools: [{ callId: "c1", result: "r1" }],
        toolCallCount: 0,
        currentReplyId: "r0",
      },
      turnPromise: p,
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "done" });
    expect(s2s.sendToolResult).not.toHaveBeenCalled();
    resolve();
    await vi.waitFor(() => {
      expect(s2s.sendToolResult).toHaveBeenCalledWith("c1", "r1");
    });
  });

  test("reply_done without pending tools logs step count when steps > 0", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = makeCtx({
      reply: { pendingTools: [], toolCallCount: 3, currentReplyId: "r0" },
      turnPromise: null,
      log,
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "done" });
    expect(log.info).toHaveBeenCalledWith("Turn complete", { steps: 3, agent: "test-agent" });
  });

  test("reply_done without pending tools skips step log when steps = 0", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = makeCtx({
      reply: { pendingTools: [], toolCallCount: 0, currentReplyId: "r0" },
      turnPromise: null,
      log,
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "done" });
    expect(log.info).not.toHaveBeenCalledWith("Turn complete", expect.any(Object));
  });

  test("reply_done without pending tools fires afterTurn hook", () => {
    const ctx = makeCtx({
      reply: { pendingTools: [], toolCallCount: 0, currentReplyId: "r0" },
      turnPromise: null,
      hookInvoker: makeHook({ afterTurn: vi.fn(async () => undefined) }),
      conversationMessages: [{ role: "assistant", content: "hello" }],
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("replyDone", { status: "done" });
    expect(ctx.fireHook).toHaveBeenCalledWith("afterTurn", expect.any(Function));
  });

  test("reply_done stale reply: clears pendingTools to free memory", () => {
    const ctx = makeCtx({
      reply: {
        pendingTools: [{ callId: "c1", result: "r1" }],
        toolCallCount: 0,
        currentReplyId: "reply-1",
      },
      turnPromise: null,
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    // Change reply ID to simulate a new reply after replyDone captured its ID.
    ctx.reply.currentReplyId = "reply-2";
    h._fire("replyDone", { status: "done" });
    expect(ctx.reply.pendingTools).toEqual([]);
  });

  test("finishToolCall caps pendingTools at maxHistory", async () => {
    const ctx = makeCtx({ maxHistory: 3 } as Partial<S2sSessionCtx>);
    // Simulate 4 sequential tool calls in the same reply generation.
    for (let i = 0; i < 4; i++) {
      await handleToolCall(ctx, tc({ callId: `call-${i}`, name: "myTool" }));
    }
    expect(ctx.reply.pendingTools).toHaveLength(3);
    // The oldest entry (call-0) should have been evicted.
    expect(ctx.reply.pendingTools[0]?.callId).toBe("call-1");
  });

  test("user_transcript: pushes message and fires turn hook", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("userTranscript", { itemId: "i1", text: "hello" });
    expect(ctx.conversationMessages).toEqual([{ role: "user", content: "hello" }]);
    expect(allEvents(ctx)).toContainEqual({ type: "transcript", text: "hello", isFinal: true });
    expect(allEvents(ctx)).toContainEqual({ type: "turn", text: "hello" });
    expect(ctx.fireHook).toHaveBeenCalledWith("onTurn", expect.any(Function));
  });

  test("user_transcript with filterInput: pushes filtered text to messages", async () => {
    const ctx = makeCtx({
      hookInvoker: makeHook({
        filterInput: vi.fn(async (_sid, text) => text.replace(/secret/g, "[REDACTED]")),
      }),
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("userTranscript", { itemId: "i1", text: "the secret code" });
    await vi.waitFor(() => {
      // Original text in transcript event, filtered text in messages
      expect(allEvents(ctx)).toContainEqual({
        type: "transcript",
        text: "the secret code",
        isFinal: true,
      });
      expect(ctx.conversationMessages).toEqual([{ role: "user", content: "the [REDACTED] code" }]);
    });
  });

  test("user_transcript with beforeTurn block: emits chat + tts_done", async () => {
    const ctx = makeCtx({
      hookInvoker: makeHook({ beforeTurn: vi.fn(async () => "not allowed") }),
    });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("userTranscript", { itemId: "i1", text: "hello" });
    await vi.waitFor(() => {
      expect(allEvents(ctx)).toContainEqual({ type: "chat", text: "not allowed" });
      expect(allEvents(ctx)).toContainEqual({ type: "tts_done" });
    });
  });

  test("session_expired closes handle", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("sessionExpired", { code: "expired", message: "gone" });
    expect(h.close).toHaveBeenCalled();
  });

  test("error event: emits error and closes handle", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("error", { code: "500", message: "oops" });
    expect(allEvents(ctx)).toContainEqual({ type: "error", code: "internal", message: "oops" });
    expect(h.close).toHaveBeenCalled();
  });

  test("close event: sets s2s to null", () => {
    const ctx = makeCtx({ s2s: makeMockHandle() });
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("close");
    expect(ctx.s2s).toBeNull();
  });

  test("audio event: forwards chunk to client", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    const chunk = new Uint8Array([1, 2, 3]);
    h._fire("audio", { audio: chunk });
    expect(ctx.client.playAudioChunk).toHaveBeenCalledWith(chunk);
  });

  test("agent_transcript_delta: emits chat_delta", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("agentTranscriptDelta", { text: "hi" });
    expect(allEvents(ctx)).toContainEqual({ type: "chat_delta", text: "hi" });
  });

  test("agent_transcript: pushes to conversation and emits chat", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("agentTranscript", {
      text: "response",
      replyId: "r1",
      itemId: "i1",
      interrupted: false,
    });
    expect(ctx.conversationMessages).toEqual([{ role: "assistant", content: "response" }]);
    expect(allEvents(ctx)).toContainEqual({ type: "chat", text: "response" });
  });

  test("agent_transcript interrupted: emits chat but does not push to conversation", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("agentTranscript", {
      text: "partial resp",
      replyId: "r1",
      itemId: "i1",
      interrupted: true,
    });
    expect(ctx.conversationMessages).toEqual([]);
    expect(allEvents(ctx)).toContainEqual({ type: "chat", text: "partial resp" });
  });

  test("speech events forwarded", () => {
    const ctx = makeCtx();
    const h = makeMockHandle();
    setupListeners(ctx, h);
    h._fire("speechStarted");
    h._fire("speechStopped");
    expect(allEvents(ctx)).toContainEqual({ type: "speech_started" });
    expect(allEvents(ctx)).toContainEqual({ type: "speech_stopped" });
  });
});
