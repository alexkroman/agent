// Copyright 2026 the AAI authors. MIT license.
// connectS2s connection/handle API and error/close handling specs. Server
// event dispatch specs live in s2s-events.test.ts; shared helpers in
// _s2s-test-utils.ts.

import { DEFAULT_VOICE_FOCUS, DEFAULT_VOICE_FOCUS_THRESHOLD } from "@alexkroman1/aai/host-internal";
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

  // The S2S default is the service's 0.7 while the pipeline STT stage pins 0.9,
  // so an S2S agent ran with weaker background-speech suppression than a
  // pipeline agent on the same audio — measured to be what decides spelled
  // name/ZIP authentication on tau2-bench retail. Both now read one constant.
  test("updateSession pins voice focus on the input block", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [] });

    const sent = lastSent(raw) as {
      session: { input: Record<string, unknown>; output: Record<string, unknown> };
    };
    expect(sent.session.input).toMatchObject({
      voice_focus: DEFAULT_VOICE_FOCUS,
      voice_focus_threshold: DEFAULT_VOICE_FOCUS_THRESHOLD,
    });
    // Declaring the format stays authoritative — it is the one S2S failure with
    // no symptom at all, so the pin must not have displaced it.
    expect(sent.session.input).toMatchObject({ format: { encoding: "audio/pcm" } });
    // Voice focus is an INPUT concern; sending it on output would be a rejected
    // field on a session that otherwise looks healthy.
    expect(sent.session.output).not.toHaveProperty("voice_focus");
  });

  // `sttPrompt` was pipeline-only, which made it a SILENT no-op for every S2S
  // agent: it reached the agent definition and only the pipeline transport read
  // it. The service's matching field is `input.transcription_prompt`.
  test("updateSession sends sttPrompt as input.transcription_prompt", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({
      systemPrompt: "test",
      tools: [],
      sttPrompt: "Expect spelled-out names and five-digit ZIP codes.",
    });

    const sent = lastSent(raw) as { session: Record<string, unknown> };
    const input = sent.session.input as Record<string, unknown>;
    expect(input.transcription_prompt).toBe("Expect spelled-out names and five-digit ZIP codes.");
    // An SDK field name must never reach the wire — the service rejects unknown
    // keys, and the spread that builds `session` would otherwise carry it.
    expect(sent.session).not.toHaveProperty("sttPrompt");
  });

  // The three descriptor options. Each rides a DIFFERENT wire block — voice on
  // `output`, the other two on `input` — so a single spread would not have
  // covered them, and none was reachable at all before `assemblyAIS2s()` took
  // options.
  test("updateSession sends voice on output and languages/keyterms on input", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({
      systemPrompt: "test",
      tools: [],
      voice: "michael",
      languages: ["en", "es"],
      keyterms: ["Acme Rewards", "SKU"],
    });

    const sent = lastSent(raw) as {
      session: { input: Record<string, unknown>; output: Record<string, unknown> };
    };
    expect(sent.session.output).toMatchObject({ voice: "michael" });
    expect(sent.session.input).toMatchObject({
      language_codes: ["en", "es"],
      keyterms: ["Acme Rewards", "SKU"],
    });
    // SDK field names must never reach the wire — the service rejects unknown
    // keys, and the spread that builds `session` would otherwise carry them.
    expect(sent.session).not.toHaveProperty("voice");
    expect(sent.session).not.toHaveProperty("languages");
    expect(sent.session).not.toHaveProperty("keyterms");
  });

  // Unset `language_codes` means "detect per turn" service-side. Sending an
  // empty array instead of omitting the key would be a claim about the call's
  // languages, not the absence of one.
  test("updateSession omits language_codes and keyterms when unset or empty", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [], languages: [], keyterms: [] });

    const sent = lastSent(raw) as { session: { input: Record<string, unknown> } };
    expect(sent.session.input).not.toHaveProperty("language_codes");
    expect(sent.session.input).not.toHaveProperty("keyterms");
  });

  test("updateSession omits output.voice when the agent picks none", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [] });

    const sent = lastSent(raw) as { session: { output: Record<string, unknown> } };
    expect(sent.session.output).not.toHaveProperty("voice");
    // The format still goes out — omitting it is the S2S failure with no
    // symptom at all (the agent greets and is then permanently deaf).
    expect(sent.session.output).toHaveProperty("format");
  });

  test("updateSession omits transcription_prompt when there is no sttPrompt", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [] });

    const sent = lastSent(raw) as { session: { input: Record<string, unknown> } };
    expect(sent.session.input).not.toHaveProperty("transcription_prompt");
  });

  // Whitespace-only is "not configured", not "bias on nothing".
  test("updateSession omits transcription_prompt for a blank sttPrompt", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [], sttPrompt: "   \n " });

    const sent = lastSent(raw) as { session: { input: Record<string, unknown> } };
    expect(sent.session.input).not.toHaveProperty("transcription_prompt");
  });

  // Trimmed here rather than left to the service: an over-long value is a
  // rejected field on a session that otherwise looks healthy, so the failure
  // would present as unbiased transcription rather than a config error. Keeps
  // the HEAD — this is a standing vocabulary description, so its opening is the
  // substantive part (unlike `agent_context`, which keeps its tail).
  test("updateSession trims a long sttPrompt to the documented cap", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({
      systemPrompt: "test",
      tools: [],
      sttPrompt: `${"a".repeat(1750)}TAIL`,
    });

    const sent = lastSent(raw) as { session: { input: { transcription_prompt?: string } } };
    const prompt = sent.session.input.transcription_prompt ?? "";
    expect(prompt).toHaveLength(1750);
    // The tail is what gets dropped, not the head.
    expect(prompt.endsWith("TAIL")).toBe(false);
  });

  // `turn_detection` is deliberately left unset: the service's default is
  // adaptive and entity-aware (it waits out a spelled-out value), and setting
  // `min_silence`/`max_silence` turns both off for the rest of the session.
  test("updateSession does not pin turn_detection", async () => {
    const { raw, handle } = await setupHandle();

    handle.updateSession({ systemPrompt: "test", tools: [] });

    const sent = lastSent(raw) as { session: { input: Record<string, unknown> } };
    expect(sent.session.input).not.toHaveProperty("turn_detection");
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
