// Copyright 2026 the AAI authors. MIT license.
// connectS2s server-event dispatch specs: speech, transcript, reply, tool,
// and audio events. Connection/handle API and error/close specs live in
// s2s.test.ts; shared helpers in _s2s-test-utils.ts.

import { describe, expect, test, vi } from "vitest";
import {
  createTestS2s,
  emitMessage,
  makeMockCallbacks,
  s2sConfig,
  setupHandle,
} from "./_s2s-test-utils.ts";
import { connectS2s } from "./s2s.ts";

describe("connectS2s event dispatch", () => {
  test("session.ready dispatches 'onSessionReady' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "session.ready", session_id: "s123" });

    expect(callbacks.onSessionReady).toHaveBeenCalledOnce();
    expect(callbacks.onSessionReady).toHaveBeenCalledWith("s123");
  });

  test("input.speech.started dispatches 'onSpeechStarted' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "input.speech.started" });

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
  });

  test("input.speech.stopped dispatches 'onSpeechStopped' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    // speech_stopped is only forwarded after a speech_started primes VAD state.
    emitMessage(raw, { type: "input.speech.started" });
    emitMessage(raw, { type: "input.speech.stopped" });

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
    expect(callbacks.onSpeechStopped).toHaveBeenCalledOnce();
  });

  test("duplicate input.speech.stopped is suppressed", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "input.speech.started" });
    emitMessage(raw, { type: "input.speech.stopped" });
    emitMessage(raw, { type: "input.speech.stopped" });

    expect(callbacks.onSpeechStopped).toHaveBeenCalledOnce();
  });

  test("transcript.user dispatches 'onUserTranscript' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "transcript.user", item_id: "item-1", text: "Hello world" });

    expect(callbacks.onUserTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("Hello world");
  });

  test("reply.started dispatches 'onReplyStarted' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });

    expect(callbacks.onReplyStarted).toHaveBeenCalledOnce();
    expect(callbacks.onReplyStarted).toHaveBeenCalledWith("r1");
  });

  test("transcript.agent dispatches 'onAgentTranscript' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "transcript.agent",
      text: "Full response",
      reply_id: "r1",
      item_id: "i1",
      interrupted: false,
    });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Full response", false);
  });

  test("transcript.agent defaults interrupted to false when missing", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "transcript.agent", text: "response" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("response", false);
  });

  test("transcript.agent with interrupted:true passes interrupted:true", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "transcript.agent",
      text: "Interrupted response",
      interrupted: true,
    });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Interrupted response", true);
  });

  test("tool.call dispatches 'onToolCall' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "tool.call",
      call_id: "c1",
      name: "web_search",
      args: { query: "test" },
    });

    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
    expect(callbacks.onToolCall).toHaveBeenCalledWith("c1", "web_search", { query: "test" });
  });

  test("reply.done (non-interrupted) dispatches 'onReplyDone' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    expect(callbacks.onCancelled).not.toHaveBeenCalled();
  });

  test("reply.done with status 'interrupted' dispatches 'onCancelled' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.done", status: "interrupted" });

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

    emitMessage(raw, { type: "reply.done", status: "completed" });

    const arrivalCall = infoSpy.mock.calls.find((c) => c[0] === "S2S << reply.done");
    expect(arrivalCall).toBeDefined();
    expect(arrivalCall?.[1]).toEqual({ sid: "sess-abc", status: "completed" });
  });

  test("reply.audio dispatches 'onAudio' callback with decoded Uint8Array", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    const audioBytes = new Uint8Array([10, 20, 30, 40]);
    const base64 = Buffer.from(audioBytes).toString("base64");

    emitMessage(raw, { type: "reply.audio", data: base64 });

    expect(callbacks.onAudio).toHaveBeenCalledOnce();
    const payload = (callbacks.onAudio as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload)).toEqual([10, 20, 30, 40]);
  });

  test("reply.content_part events are silently ignored (no dispatch)", async () => {
    const { raw } = await setupHandle();
    emitMessage(raw, { type: "reply.content_part.started" });
    emitMessage(raw, { type: "reply.content_part.done" });
  });
});
