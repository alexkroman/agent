// Copyright 2026 the AAI authors. MIT license.
// connectS2s connection/handle API and error/close handling specs. Server
// event dispatch specs live in s2s-events.test.ts; shared helpers in
// _s2s-test-utils.ts.

import { describe, expect, test } from "vitest";
import {
  createWebSocketStub,
  emitMessage,
  errorArg,
  lastSent,
  makeMockCallbacks,
  s2sConfig,
  setupHandle,
} from "./_s2s-test-utils.ts";
import { silentLogger } from "./_test-utils.ts";
import { connectS2s } from "./s2s.ts";

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
        callbacks: makeMockCallbacks(),
        logger: silentLogger,
      }),
    ).rejects.toThrow("connection refused");
  });

  test("updateSession sends session.update message", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [] });

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = lastSent(raw) as { type: string; session: { system_prompt: string } };
    expect(sent.type).toBe("session.update");
    expect(sent.session.system_prompt).toBe("test");
  });

  test("sendAudio sends base64-encoded audio when open", async () => {
    const { raw, handle } = await setupHandle();

    handle.sendAudio(new Uint8Array([1, 2, 3, 4]));

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = lastSent(raw);
    expect(sent.type).toBe("input.audio");
    expect(typeof sent.audio).toBe("string");
  });

  test("sendAudio drops frames while the provider socket buffer exceeds the cap", async () => {
    const { raw, handle, logger } = await setupHandle();

    // Stalled provider link: unsent bytes past the cap → frames drop, one warn.
    Object.assign(raw, { bufferedAmount: 8 * 1024 * 1024 });
    handle.sendAudio(new Uint8Array([1, 2, 3, 4]));
    handle.sendAudio(new Uint8Array([5, 6, 7, 8]));
    expect(raw.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Buffer drained: sending resumes.
    Object.assign(raw, { bufferedAmount: 0 });
    handle.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(raw.send).toHaveBeenCalledOnce();
  });

  test("sendAudio is no-op when ws is not open", async () => {
    const { raw, handle } = await setupHandle();
    raw.readyState = 3;

    handle.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(raw.send).not.toHaveBeenCalled();
  });

  test("sendToolResult sends tool.result message", async () => {
    const { raw, handle } = await setupHandle();

    handle.sendToolResult("call-123", "result-text");

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = lastSent(raw);
    expect(sent.type).toBe("tool.result");
    expect(sent.call_id).toBe("call-123");
    expect(sent.result).toBe("result-text");
  });

  test("resumeSession sends session.resume message", async () => {
    const { raw, handle } = await setupHandle();

    handle.resumeSession("session-abc");

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = lastSent(raw);
    expect(sent.type).toBe("session.resume");
    expect(sent.session_id).toBe("session-abc");
  });

  test("close() sends Normal Closure so our own teardown is distinguishable", async () => {
    // Without an explicit code the close frame carries no status, and both
    // ends report 1005 "No Status Received" — identical to the peer dropping
    // us. 1005 is also in TRANSIENT_CLOSE_CODES, so an intentional close
    // would look resumable. Saying 1000 keeps the two apart in the logs.
    const { raw, handle } = await setupHandle();
    handle.close();
    expect(raw.close).toHaveBeenCalledWith(1000);
  });

  test("close() closes the underlying ws", async () => {
    const { raw, handle } = await setupHandle();

    handle.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });

  test("send is no-op when ws is not open", async () => {
    const { raw, handle } = await setupHandle();
    raw.readyState = 3;

    handle.updateSession({ systemPrompt: "test", tools: [] });
    expect(raw.send).not.toHaveBeenCalled();
  });

  test("session.error with session_not_found dispatches 'onSessionExpired' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "session.error",
      code: "session_not_found",
      message: "Session not found",
    });

    expect(callbacks.onSessionExpired).toHaveBeenCalledOnce();
  });

  test("session.error with session_forbidden dispatches 'onSessionExpired' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "session.error",
      code: "session_forbidden",
      message: "Forbidden",
    });

    expect(callbacks.onSessionExpired).toHaveBeenCalledOnce();
  });

  test("session.error with other code dispatches 'onError' callback with Error object", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "session.error",
      code: "rate_limit",
      message: "Too many requests",
    });

    expect(callbacks.onError).toHaveBeenCalledOnce();
    const err = errorArg(callbacks);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Too many requests");
  });

  test("bare error dispatches 'onError' callback with Error object", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "error", message: "Bad gateway" });

    expect(callbacks.onError).toHaveBeenCalledOnce();
    const err = errorArg(callbacks);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Bad gateway");
  });

  test("invalid JSON message is logged and ignored", async () => {
    const { raw, logger } = await setupHandle();

    raw.emit("message", Buffer.from("not-valid-json{{{"));

    expect(logger.warn).toHaveBeenCalledWith("S2S << invalid JSON", expect.any(Object));
  });

  test("unrecognized message type is logged and ignored", async () => {
    const { raw, logger } = await setupHandle();

    emitMessage(raw, { type: "totally.unknown.type" });

    expect(logger.warn).toHaveBeenCalled();
  });

  test("session.updated without config.id is silently ignored (no dispatch)", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "session.updated" });

    expect(callbacks.onSessionReady).not.toHaveBeenCalled();
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    expect(callbacks.onReplyDone).not.toHaveBeenCalled();
    expect(callbacks.onSpeechStarted).not.toHaveBeenCalled();
    expect(callbacks.onSpeechStopped).not.toHaveBeenCalled();
  });

  test("session.updated with config.id dispatches 'onSessionReady' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "session.updated",
      config: { id: "sess_from_updated", system_prompt: "x", tools: [] },
    });

    expect(callbacks.onSessionReady).toHaveBeenCalledOnce();
    expect(callbacks.onSessionReady).toHaveBeenCalledWith("sess_from_updated");
  });

  test("close event dispatches 'onClose' callback with code and reason", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("close", 1000, "normal");

    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onClose).toHaveBeenCalledWith(1000, "normal");
  });

  test("a post-open socket error is folded into the close, not surfaced as its own error", async () => {
    // `ws` always follows a fatal socket error with `close`, and the close
    // path is where the transport decides between resuming and failing the
    // session. Surfacing the error immediately sent the client a
    // fatal-looking frame for the most common transient-drop shape
    // (error-then-close), defeating the resume that followed.
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    raw.emit("error", new Error("ws transport error"));
    expect(callbacks.onError).not.toHaveBeenCalled();

    // The close that follows carries the error message as its reason.
    raw.emit("close", 1006, "");
    expect(callbacks.onClose).toHaveBeenCalledWith(1006, "ws transport error");
  });
});
