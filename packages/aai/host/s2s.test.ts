import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import type { S2sCallbacks, S2sWebSocket } from "./s2s.ts";
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

function makeMockCallbacks(): S2sCallbacks {
  return {
    onSessionReady: vi.fn(),
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudio: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onSessionExpired: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
}

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

async function setupHandle(callbacks?: S2sCallbacks) {
  const { raw, createWebSocket, logger } = createTestS2s();
  const handle = await connectS2s({
    apiKey: "test-key",
    config: s2sConfig,
    createWebSocket,
    callbacks: callbacks ?? makeMockCallbacks(),
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
        sendAudioRaw: expect.any(Function),
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
        callbacks: makeMockCallbacks(),
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

  test("sendAudioRaw forwards the exact string to the socket", async () => {
    const { raw, handle } = await setupHandle();

    const frame = '{"type":"input.audio","audio":"abc"}';
    handle.sendAudioRaw(frame);

    expect(raw.send).toHaveBeenCalledOnce();
    expect(raw.send.mock.calls[0]?.[0]).toBe(frame);
  });

  test("sendAudioRaw is no-op when ws is not open", async () => {
    const { raw, handle } = await setupHandle();
    raw.readyState = 3; // CLOSED

    handle.sendAudioRaw('{"type":"input.audio","audio":"abc"}');
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

  test("session.ready dispatches 'onSessionReady' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "session.ready",
          session_id: "s123",
        }),
      ),
    );

    expect(callbacks.onSessionReady).toHaveBeenCalledOnce();
    expect(callbacks.onSessionReady).toHaveBeenCalledWith("s123");
  });

  test("input.speech.started dispatches 'onSpeechStarted' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.started" })));

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
  });

  test("input.speech.stopped dispatches 'onSpeechStopped' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    // Prime VAD state — speech_stopped is only forwarded after a speech_started.
    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.started" })));
    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.stopped" })));

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
    expect(callbacks.onSpeechStopped).toHaveBeenCalledOnce();
  });

  test("duplicate input.speech.stopped is suppressed", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.started" })));
    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.stopped" })));
    raw.emit("message", Buffer.from(JSON.stringify({ type: "input.speech.stopped" })));

    expect(callbacks.onSpeechStopped).toHaveBeenCalledOnce();
  });

  test("transcript.user dispatches 'onUserTranscript' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onUserTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("Hello world");
  });

  test("reply.started dispatches 'onReplyStarted' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.started",
          reply_id: "r1",
        }),
      ),
    );

    expect(callbacks.onReplyStarted).toHaveBeenCalledOnce();
    expect(callbacks.onReplyStarted).toHaveBeenCalledWith("r1");
  });

  test("transcript.agent dispatches 'onAgentTranscript' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Full response", false);
  });

  test("transcript.agent defaults interrupted to false when missing", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "transcript.agent", text: "response" })),
    );

    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("response", false);
  });

  test("transcript.agent with interrupted:true passes interrupted:true", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Interrupted response", true);
  });

  test("tool.call dispatches 'onToolCall' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
    expect(callbacks.onToolCall).toHaveBeenCalledWith("c1", "web_search", { query: "test" });
  });

  test("reply.done (non-interrupted) dispatches 'onReplyDone' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.done",
          status: "completed",
        }),
      ),
    );

    expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    expect(callbacks.onCancelled).not.toHaveBeenCalled();
  });

  test("reply.done with status 'interrupted' dispatches 'onCancelled' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "reply.done",
          status: "interrupted",
        }),
      ),
    );

    expect(callbacks.onCancelled).toHaveBeenCalledOnce();
    expect(callbacks.onReplyDone).not.toHaveBeenCalled();
  });

  test("reply.done arrival is logged with sid and status", async () => {
    const { raw, createWebSocket, logger } = createTestS2s();
    const infoSpy = vi.fn();
    logger.info = infoSpy;
    await connectS2s({
      apiKey: "test-key",
      config: s2sConfig,
      createWebSocket,
      callbacks: makeMockCallbacks(),
      logger,
      sid: "sess-abc",
    });

    raw.emit("message", Buffer.from(JSON.stringify({ type: "reply.done", status: "completed" })));

    const arrivalCall = infoSpy.mock.calls.find((c) => c[0] === "S2S << reply.done");
    expect(arrivalCall).toBeDefined();
    expect(arrivalCall?.[1]).toEqual({ sid: "sess-abc", status: "completed" });
  });

  test("session.error with session_not_found dispatches 'onSessionExpired' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onSessionExpired).toHaveBeenCalledOnce();
  });

  test("session.error with session_forbidden dispatches 'onSessionExpired' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onSessionExpired).toHaveBeenCalledOnce();
  });

  test("session.error with other code dispatches 'onError' callback with Error object", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onError).toHaveBeenCalledOnce();
    const err = (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Too many requests");
  });

  test("bare error dispatches 'onError' callback with Error object", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          message: "Bad gateway",
        }),
      ),
    );

    expect(callbacks.onError).toHaveBeenCalledOnce();
    const err = (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Bad gateway");
  });

  // ─── Audio fast path ───────────────────────────────────────────────────

  test("reply.audio dispatches 'onAudio' callback with decoded Uint8Array", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

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

    expect(callbacks.onAudio).toHaveBeenCalledOnce();
    const payload = (callbacks.onAudio as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload)).toEqual([10, 20, 30, 40]);
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
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    // session.updated is dropped — no callbacks fired
    expect(callbacks.onSessionReady).not.toHaveBeenCalled();
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    expect(callbacks.onReplyDone).not.toHaveBeenCalled();
    expect(callbacks.onSpeechStarted).not.toHaveBeenCalled();
    expect(callbacks.onSpeechStopped).not.toHaveBeenCalled();
  });

  // ─── Close and error events ────────────────────────────────────────────

  test("close event dispatches 'onClose' callback with code and reason", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("close", 1000, "normal");

    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onClose).toHaveBeenCalledWith(1000, "normal");
  });

  test("error after open dispatches 'onError' callback with Error object", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("error", new Error("ws transport error"));

    expect(callbacks.onError).toHaveBeenCalledOnce();
    const err = (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("ws transport error");
  });
});
