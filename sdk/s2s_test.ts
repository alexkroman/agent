import { describe, expect, test, vi } from "vitest";
import { connectS2s, wrapOnStyleWebSocket } from "./s2s.ts";

// Minimal on-style WebSocket stub (matches the `ws` npm package interface)
function createOnStyleStub() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const s2sConfig = { wssUrl: "wss://fake", inputSampleRate: 16000, outputSampleRate: 16000 };

function createTestS2s() {
  const raw = createOnStyleStub();
  const createWebSocket = () => {
    setTimeout(() => {
      raw.readyState = 1;
      raw.emit("open");
    }, 0);
    return wrapOnStyleWebSocket(raw);
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

describe("wrapOnStyleWebSocket", () => {
  test("readyState reflects the underlying WebSocket state", () => {
    const raw = createOnStyleStub();
    raw.readyState = 0;
    const wrapped = wrapOnStyleWebSocket(raw);

    expect(wrapped.readyState).toBe(0);
    raw.readyState = 1;
    expect(wrapped.readyState).toBe(1);
    raw.readyState = 3;
    expect(wrapped.readyState).toBe(3);
  });

  test("dispatches open event", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    const onOpen = vi.fn();
    wrapped.addEventListener("open", onOpen);

    raw.emit("open");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("dispatches message event with data", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    const onMessage = vi.fn();
    wrapped.addEventListener("message", onMessage);

    const payload = Buffer.from('{"type":"session.updated"}');
    raw.emit("message", payload);

    expect(onMessage).toHaveBeenCalledOnce();
    const ev = onMessage.mock.calls[0]?.[0] as MessageEvent;
    expect(ev.data).toBe(payload);
  });

  test("dispatches close event with code and reason", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    const onClose = vi.fn();
    wrapped.addEventListener("close", onClose);

    raw.emit("close", 1001, "going away");

    expect(onClose).toHaveBeenCalledOnce();
    const ev = onClose.mock.calls[0]?.[0] as CloseEvent;
    expect(ev.code).toBe(1001);
    expect(ev.reason).toBe("going away");
  });

  test("dispatches error event with message", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    const onError = vi.fn();
    wrapped.addEventListener("error", onError);

    raw.emit("error", new Error("connection refused"));

    expect(onError).toHaveBeenCalledOnce();
    const ev = onError.mock.calls[0]?.[0] as ErrorEvent;
    expect(ev.message).toBe("connection refused");
  });

  test("send delegates to underlying WebSocket", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    wrapped.send('{"type":"test"}');
    expect(raw.send).toHaveBeenCalledWith('{"type":"test"}');
  });

  test("close delegates to underlying WebSocket", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    wrapped.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });
});

describe("connectS2s", () => {
  test("resolves with handle after open", async () => {
    const { handle } = await setupHandle();
    expect(handle).toBeDefined();
    expect(typeof handle.sendAudio).toBe("function");
    expect(typeof handle.sendToolResult).toBe("function");
    expect(typeof handle.updateSession).toBe("function");
    expect(typeof handle.resumeSession).toBe("function");
    expect(typeof handle.close).toBe("function");
  });

  test("rejects when error fires before open", async () => {
    const raw = createOnStyleStub();
    const createWebSocket = () => {
      setTimeout(() => {
        raw.emit("error", new Error("connection refused"));
      }, 0);
      return wrapOnStyleWebSocket(raw);
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

    handle.updateSession({ system_prompt: "test", tools: [] });

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(raw.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("session.update");
    expect(sent.session.system_prompt).toBe("test");
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

    handle.updateSession({ system_prompt: "test", tools: [] });
    expect(raw.send).not.toHaveBeenCalled();
  });

  // ─── Message dispatch ──────────────────────────────────────────────────

  test("session.ready dispatches 'ready' event", async () => {
    const { raw, handle } = await setupHandle();
    const onReady = vi.fn();
    handle.addEventListener("ready", onReady);

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
    const detail = (onReady.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.session_id).toBe("s123");
  });

  test("input.speech.started dispatches 'speech_started'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("speech_started", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.started" })));
    expect(handler).toHaveBeenCalledOnce();
  });

  test("input.speech.stopped dispatches 'speech_stopped'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("speech_stopped", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.stopped" })));
    expect(handler).toHaveBeenCalledOnce();
  });

  test("transcript.user.delta dispatches 'user_transcript_delta'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("user_transcript_delta", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.user.delta",
          text: "Hel",
        }),
      ),
    );

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.text).toBe("Hel");
  });

  test("transcript.user dispatches 'user_transcript'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("user_transcript", handler);

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

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.item_id).toBe("item-1");
    expect(detail.text).toBe("Hello world");
  });

  test("reply.started dispatches 'reply_started'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("reply_started", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.started",
          reply_id: "r1",
        }),
      ),
    );

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.reply_id).toBe("r1");
  });

  test("transcript.agent.delta dispatches 'agent_transcript_delta'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("agent_transcript_delta", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.agent.delta",
          delta: "I think",
        }),
      ),
    );

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.text).toBe("I think");
  });

  test("transcript.agent dispatches 'agent_transcript'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("agent_transcript", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "transcript.agent",
          text: "Full response",
        }),
      ),
    );

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.text).toBe("Full response");
  });

  test("tool.call dispatches 'tool_call'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("tool_call", handler);

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

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.call_id).toBe("c1");
    expect(detail.name).toBe("web_search");
    expect(detail.args).toEqual({ query: "test" });
  });

  test("reply.done dispatches 'reply_done'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("reply_done", handler);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.done",
          status: "completed",
        }),
      ),
    );

    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.status).toBe("completed");
  });

  test("session.error with session_not_found dispatches 'session_expired'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("session_expired", handler);

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

  test("session.error with session_forbidden dispatches 'session_expired'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("session_expired", handler);

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
    handle.addEventListener("error", handler);

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
    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.code).toBe("rate_limit");
  });

  test("bare error dispatches 'error' with code 'connection'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("error", handler);

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
    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.code).toBe("connection");
    expect(detail.message).toBe("Bad gateway");
  });

  // ─── Audio fast path ───────────────────────────────────────────────────

  test("reply.audio dispatches 'audio' with decoded Uint8Array", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("audio", handler);

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
    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.audio).toBeInstanceOf(Uint8Array);
    expect(Array.from(detail.audio)).toEqual([10, 20, 30, 40]);
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
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    // These types return undefined from S2S_DISPATCH
    handle.addEventListener("reply.content_part.started", handler);
    handle.addEventListener("reply.content_part.done", handler);

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

    expect(handler).not.toHaveBeenCalled();
  });

  // ─── Close and error events ────────────────────────────────────────────

  test("close event dispatches 'close' on handle", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("close", handler);

    raw.emit("close", 1000, "normal");

    expect(handler).toHaveBeenCalledOnce();
  });

  test("error after open dispatches 'error' event on handle", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("error", handler);

    raw.emit("error", new Error("ws transport error"));

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail.code).toBe("ws_error");
  });

  test("session.updated dispatches 'session_updated'", async () => {
    const { raw, handle } = await setupHandle();
    const handler = vi.fn();
    handle.addEventListener("session_updated", handler);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    expect(handler).toHaveBeenCalledOnce();
  });
});
