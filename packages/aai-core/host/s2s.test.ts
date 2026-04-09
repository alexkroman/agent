import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import type { S2sWebSocket } from "./s2s.ts";
import { connectS2s } from "./s2s.ts";

/** EventTarget-based WebSocket stub (standard API, no `.on()` adapter needed). */
function createWebSocketStub() {
  const target = new EventTarget();
  return Object.assign(target, {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: target.addEventListener.bind(target) as S2sWebSocket["addEventListener"],
    /** Simulate a server-side event for testing. */
    emit(event: string, ...args: unknown[]) {
      const builders: Record<string, () => Event> = {
        open: () => new Event("open"),
        message: () => new MessageEvent("message", { data: args[0] }),
        close: () => {
          const ev = new Event("close");
          if (typeof args[0] === "number") Object.assign(ev, { code: args[0] });
          if (typeof args[1] === "string") Object.assign(ev, { reason: args[1] });
          return ev;
        },
        error: () => {
          const msg = args[0] instanceof Error ? args[0].message : String(args[0]);
          const ev = new Event("error");
          Object.defineProperty(ev, "message", { value: msg });
          return ev;
        },
      };
      const build = builders[event];
      if (build) target.dispatchEvent(build());
    },
  });
}

const s2sConfig = { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 16_000 };

function createTestS2s() {
  const raw = createWebSocketStub();
  const createWebSocket = () => {
    setTimeout(() => {
      raw.readyState = 1;
      raw.emit("open");
    }, 0);
    return raw;
  };
  return { raw, createWebSocket, logger: { ...silentLogger } };
}

async function setupHandle() {
  const { raw, createWebSocket, logger } = createTestS2s();
  const handle = await connectS2s({
    apiKey: "test-key",
    config: s2sConfig,
    createWebSocket,
    logger,
  });
  return { raw, handle, logger };
}

describe("connectS2s", () => {
  test("resolves with handle after open", async () => {
    const { handle } = await setupHandle();
    expect(handle).toEqual(
      expect.objectContaining({
        sendAudio: expect.any(Function),
        sendToolResult: expect.any(Function),
        updateSession: expect.any(Function),
        resumeSession: expect.any(Function),
        close: expect.any(Function),
      }),
    );
  });

  test("rejects when error fires before open", async () => {
    const raw = createWebSocketStub();
    const createWebSocket = () => {
      setTimeout(() => {
        raw.emit("error", new Error("connection refused"));
      }, 0);
      return raw;
    };

    await expect(
      connectS2s({
        apiKey: "test-key",
        config: s2sConfig,
        createWebSocket,
        logger: silentLogger,
      }),
    ).rejects.toThrow("connection refused");
  });

  // ─── Handle methods ────────────────────────────────────────────────────

  test("updateSession sends session.update message", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [] });

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(raw.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("session.update");
    expect(sent.session.system_prompt).toBe("test"); // wire format stays snake_case
  });

  test("sendAudio sends base64-encoded audio when open", async () => {
    const { raw, handle } = await setupHandle();

    handle.sendAudio(new Uint8Array([1, 2, 3, 4]));

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(raw.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("input.audio");
    expect(typeof sent.audio).toBe("string"); // base64
  });

  test("sendAudio is no-op when ws is not open", async () => {
    const { raw, handle } = await setupHandle();
    raw.readyState = 3; // CLOSED

    handle.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(raw.send).not.toHaveBeenCalled();
  });

  test("sendToolResult sends tool.result message", async () => {
    const { raw, handle } = await setupHandle();

    handle.sendToolResult("call-123", "result-text");

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(raw.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("tool.result");
    expect(sent.call_id).toBe("call-123");
    expect(sent.result).toBe("result-text");
  });

  test("resumeSession sends session.resume message", async () => {
    const { raw, handle } = await setupHandle();

    handle.resumeSession("session-abc");

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(raw.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("session.resume");
    expect(sent.session_id).toBe("session-abc");
  });

  test("close() closes the underlying ws", async () => {
    const { raw, handle } = await setupHandle();

    handle.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });

  test("send is no-op when ws is not open", async () => {
    const { raw, handle } = await setupHandle();
    raw.readyState = 3; // CLOSED

    handle.updateSession({ systemPrompt: "test", tools: [] });
    expect(raw.send).not.toHaveBeenCalled();
  });

  // ─── Message dispatch ──────────────────────────────────────────────────

  test("session.ready dispatches 'ready' event", async () => {
    const { raw, handle } = await setupHandle();
    const onReady = vi.fn();
    handle.on("ready", onReady);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "session.ready",
          session_id: "s123",
        }),
      ),
    );

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0]?.[0].sessionId).toBe("s123");
  });

  test("input.speech.started dispatches 'speechStarted'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("speechStarted", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.started" })));
    expect(handler).toHaveBeenCalledOnce();
  });

  test("input.speech.stopped dispatches 'speechStopped'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("speechStopped", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.stopped" })));
    expect(handler).toHaveBeenCalledOnce();
  });

  test("transcript.user.delta dispatches 'userTranscriptDelta'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("userTranscriptDelta", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.user.delta",
          text: "Hel",
        }),
      ),
    );

    expect(handler.mock.calls[0]?.[0].text).toBe("Hel");
  });

  test("transcript.user dispatches 'userTranscript'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("userTranscript", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.user",
          item_id: "item-1",
          text: "Hello world",
        }),
      ),
    );

    const payload = handler.mock.calls[0]?.[0];
    expect(payload.itemId).toBe("item-1");
    expect(payload.text).toBe("Hello world");
  });

  test("reply.started dispatches 'replyStarted'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("replyStarted", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.started",
          reply_id: "r1",
        }),
      ),
    );

    expect(handler.mock.calls[0]?.[0].replyId).toBe("r1");
  });

  test("transcript.agent.delta dispatches 'agentTranscriptDelta'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("agentTranscriptDelta", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.agent.delta",
          delta: "I think",
        }),
      ),
    );

    expect(handler.mock.calls[0]?.[0].text).toBe("I think");
  });

  test("transcript.agent dispatches 'agentTranscript' with all fields", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("agentTranscript", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.agent",
          text: "Full response",
          reply_id: "r1",
          item_id: "i1",
          interrupted: false,
        }),
      ),
    );

    const payload = handler.mock.calls[0]?.[0];
    expect(payload.text).toBe("Full response");
    expect(payload.replyId).toBe("r1");
    expect(payload.itemId).toBe("i1");
    expect(payload.interrupted).toBe(false);
  });

  test("transcript.agent defaults interrupted to false when missing", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("agentTranscript", handler);

    raw.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "transcript.agent", text: "response" })),
    );

    expect(handler.mock.calls[0]?.[0].interrupted).toBe(false);
    expect(handler.mock.calls[0]?.[0].replyId).toBe("");
  });

  test("tool.call dispatches 'toolCall'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("toolCall", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "tool.call",
          call_id: "c1",
          name: "web_search",
          args: { query: "test" },
        }),
      ),
    );

    const payload = handler.mock.calls[0]?.[0];
    expect(payload.callId).toBe("c1");
    expect(payload.name).toBe("web_search");
    expect(payload.args).toEqual({ query: "test" });
  });

  test("reply.done dispatches 'replyDone'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("replyDone", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.done",
          status: "completed",
        }),
      ),
    );

    expect(handler.mock.calls[0]?.[0].status).toBe("completed");
  });

  test("session.error with session_not_found dispatches 'sessionExpired'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("sessionExpired", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "session.error",
          code: "session_not_found",
          message: "Session not found",
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
  });

  test("session.error with session_forbidden dispatches 'sessionExpired'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("sessionExpired", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "session.error",
          code: "session_forbidden",
          message: "Forbidden",
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
  });

  test("session.error with other code dispatches 'error'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("error", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "session.error",
          code: "rate_limit",
          message: "Too many requests",
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.code).toBe("rate_limit");
  });

  test("bare error dispatches 'error' with code 'connection'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("error", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          message: "Bad gateway",
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.code).toBe("connection");
    expect(payload.message).toBe("Bad gateway");
  });

  // ─── Audio fast path ───────────────────────────────────────────────────

  test("reply.audio dispatches 'audio' with decoded Uint8Array", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("audio", handler);

    const audioBytes = new Uint8Array([10, 20, 30, 40]);
    const base64 = Buffer.from(audioBytes).toString("base64");

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.audio",
          data: base64,
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.audio).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload.audio)).toEqual([10, 20, 30, 40]);
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  test("invalid JSON message is logged and ignored", async () => {
    const { raw, logger } = await setupHandle();

    raw.emit("message", Buffer.from("not-valid-json{{{"));

    expect(logger.warn).toHaveBeenCalledWith("S2S << invalid JSON", expect.any(Object));
  });

  test("unrecognized message type is logged and ignored", async () => {
    const { raw, logger } = await setupHandle();

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "totally.unknown.type",
        }),
      ),
    );

    expect(logger.warn).toHaveBeenCalled();
  });

  test("reply.content_part events are silently ignored (no dispatch)", async () => {
    const { raw } = await setupHandle();
    // These types return undefined from S2S_DISPATCH — no event should fire.
    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.content_part.started",
        }),
      ),
    );
    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.content_part.done",
        }),
      ),
    );
    // No error thrown = pass
  });

  // ─── Close and error events ────────────────────────────────────────────

  test("close event dispatches 'close' on handle", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("close", handler);

    raw.emit("close", 1000, "normal");

    expect(handler).toHaveBeenCalledOnce();
  });

  test("error after open dispatches 'error' event on handle", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("error", handler);

    raw.emit("error", new Error("ws transport error"));

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.code).toBe("ws_error");
  });

  test("session.updated dispatches 'sessionUpdated'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("sessionUpdated", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    expect(handler).toHaveBeenCalledOnce();
  });
});
