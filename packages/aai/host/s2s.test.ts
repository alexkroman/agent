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

  test("input.speech.started dispatches 'event' with type 'speech_started'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.started" })));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ type: "speech_started" });
  });

  test("input.speech.stopped dispatches 'event' with type 'speech_stopped'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.stopped" })));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ type: "speech_stopped" });
  });

  test("transcript.user dispatches 'event' with user_transcript", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

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

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({
      type: "user_transcript",
      text: "Hello world",
    });
  });

  test("reply.started dispatches 'replyStarted' event", async () => {
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

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].replyId).toBe("r1");
  });

  test("transcript.agent dispatches 'event' with agent_transcript", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

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

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.type).toBe("agent_transcript");
    expect(payload.text).toBe("Full response");
    expect(payload._interrupted).toBe(false);
  });

  test("transcript.agent defaults _interrupted to false when missing", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

    raw.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "transcript.agent", text: "response" })),
    );

    expect(handler.mock.calls[0]?.[0]._interrupted).toBe(false);
  });

  test("transcript.agent with interrupted:true sets _interrupted:true", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.agent",
          text: "Interrupted response",
          interrupted: true,
        }),
      ),
    );

    expect(handler.mock.calls[0]?.[0]._interrupted).toBe(true);
  });

  test("tool.call dispatches 'event' with tool_call shape", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

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

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]?.[0];
    expect(payload.type).toBe("tool_call");
    expect(payload.toolCallId).toBe("c1");
    expect(payload.toolName).toBe("web_search");
    expect(payload.args).toEqual({ query: "test" });
  });

  test("reply.done (non-interrupted) dispatches 'event' with type 'reply_done'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.done",
          status: "completed",
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ type: "reply_done" });
  });

  test("reply.done with status 'interrupted' dispatches 'event' with type 'cancelled'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("event", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.done",
          status: "interrupted",
        }),
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ type: "cancelled" });
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

  test("session.error with other code dispatches 'error' with Error object", async () => {
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
    const err = handler.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Too many requests");
  });

  test("bare error dispatches 'error' with Error object", async () => {
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
    const err = handler.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Bad gateway");
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

  test("session.updated is silently ignored (no dispatch)", async () => {
    const { raw, handle } = await setupHandle();
    const eventHandler = vi.fn();
    handle.on("event", eventHandler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    // session.updated is dropped — no event emitted
    expect(eventHandler).not.toHaveBeenCalled();
  });

  // ─── Close and error events ────────────────────────────────────────────

  test("close event dispatches 'close' with code and reason", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("close", handler);

    raw.emit("close", 1000, "normal");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toBe(1000);
    expect(handler.mock.calls[0]?.[1]).toBe("normal");
  });

  test("error after open dispatches 'error' with Error object", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.on("error", handler);

    raw.emit("error", new Error("ws transport error"));

    expect(handler).toHaveBeenCalledOnce();
    const err = handler.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("ws transport error");
  });

  // ─── Audio fast path validation ─────────────────────────────────────

  test("reply.audio fast path only fires for type=reply.audio with string data", async () => {
    const { raw, handle } = await setupHandle();
    const audioHandler = vi.fn();
    const eventHandler = vi.fn();
    handle.on("audio", audioHandler);
    handle.on("event", eventHandler);

    // Non-audio message with string data field should NOT take the audio fast path
    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.user",
          item_id: "i1",
          text: "hello",
          data: "some-string-data",
        }),
      ),
    );

    // audioHandler should NOT fire (data was a string but type was not reply.audio)
    expect(audioHandler).not.toHaveBeenCalled();
    // It should be dispatched as a regular event instead
    expect(eventHandler).toHaveBeenCalledOnce();
  });

  test("reply.audio with non-string data is not dispatched as audio", async () => {
    const { raw, handle } = await setupHandle();
    const audioHandler = vi.fn();
    handle.on("audio", audioHandler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.audio",
          data: 12_345,
        }),
      ),
    );

    // data is not a string → audio fast path should NOT fire
    expect(audioHandler).not.toHaveBeenCalled();
  });

  // ─── Non-object JSON message handling ───────────────────────────────

  test("null JSON message is logged and ignored", async () => {
    const { raw, handle, logger } = await setupHandle();
    const eventHandler = vi.fn();
    handle.on("event", eventHandler);

    raw.emit("message", Buffer.from("null"));

    expect(logger.warn).toHaveBeenCalledWith("S2S << non-object JSON message", expect.any(Object));
    expect(eventHandler).not.toHaveBeenCalled();
  });

  test("array JSON message is logged and ignored", async () => {
    const { raw, handle, logger } = await setupHandle();
    const eventHandler = vi.fn();
    handle.on("event", eventHandler);

    raw.emit("message", Buffer.from("[1, 2, 3]"));

    expect(logger.warn).toHaveBeenCalledWith("S2S << non-object JSON message", expect.any(Object));
    expect(eventHandler).not.toHaveBeenCalled();
  });

  // ─── WebSocket close before open ────────────────────────────────────

  test("rejects when close fires before open", async () => {
    const raw = createWebSocketStub();
    const createWebSocket = () => {
      setTimeout(() => {
        raw.emit("close", 1006, "abnormal");
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
    ).rejects.toThrow("WebSocket closed before open");
  });

  // ─── Error after open does not reject ────────────────────────────────

  test("error after open does not reject but dispatches error event", async () => {
    const { raw, handle } = await setupHandle();
    const errorHandler = vi.fn();
    handle.on("error", errorHandler);

    // This error happens AFTER open, so should emit 'error' not reject
    raw.emit("error", "generic error");

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  // ─── Error without message property uses default ────────────────────

  test("error event without message property uses default string", async () => {
    const { raw, handle } = await setupHandle();
    const errorHandler = vi.fn();
    handle.on("error", errorHandler);

    // Emit error without a message property
    const ev = new Event("error");
    raw.dispatchEvent(ev);

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0]?.[0].message).toBe("WebSocket error");
  });

  // ─── Authorization header is passed correctly ───────────────────────

  test("passes Authorization header with Bearer token", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const createWebSocket = (_url: string, opts: Record<string, unknown>) => {
      capturedOpts = opts;
      const raw = createWebSocketStub();
      setTimeout(() => {
        raw.readyState = 1;
        raw.emit("open");
      }, 0);
      return raw;
    };

    await connectS2s({
      apiKey: "my-secret-key",
      config: s2sConfig,
      createWebSocket,
      logger: silentLogger,
    });

    expect(capturedOpts).toEqual(
      expect.objectContaining({
        headers: { Authorization: "Bearer my-secret-key" },
      }),
    );
  });
});
