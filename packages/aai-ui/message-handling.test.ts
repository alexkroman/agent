// Copyright 2025 the AAI authors. MIT license.

/**
 * Tests for server→client message handling (formerly in client-handler.test.ts
 * and session.test.ts). All tests go through the session API via setupSignalsEnv().
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flush, type setupSignalsEnv as SetupFn } from "./_test-utils.ts";

// Lazy import to allow mock installation to happen first
let setupSignalsEnv: typeof SetupFn;

beforeEach(async () => {
  ({ setupSignalsEnv } = await import("./_test-utils.ts"));
});

// ─── handleMessage dispatch ─────────────────────────────────────────────────

describe("message handling: handleMessage dispatch", () => {
  let env: ReturnType<typeof SetupFn>;

  beforeEach(async () => {
    env = setupSignalsEnv();
    await env.connect();
  });

  afterEach(() => {
    env.session.disconnect();
    env.restore();
  });

  test("binary ArrayBuffer dispatches audio chunk and transitions to speaking", () => {
    env.session.state.value = "listening" as never;
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    env.mock.lastWs?.simulateMessage(buf);
    expect(env.session.state.value).toBe("speaking");
  });

  test("malformed JSON is silently ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    env.session.state.value = "listening" as never;
    env.mock.lastWs?.simulateMessage("not valid json {{{");
    expect(env.session.state.value).toBe("listening");
    warn.mockRestore();
  });

  test("unknown but well-formed message type is silently ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    env.session.state.value = "listening" as never;
    env.mock.lastWs?.simulateMessage(JSON.stringify({ type: "unknown_event_type", data: 123 }));
    expect(env.session.state.value).toBe("listening");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("config message triggers onSessionId and audio init", async () => {
    // Config message is handled by the connect flow — state goes to "ready"
    // on open, then config triggers audio init. We can't directly inspect the
    // return value, but we verify the session processes it without error.
    env.mock.lastWs?.simulateMessage(
      JSON.stringify({
        type: "config",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }),
    );
    await flush();
    // State should still be "ready" (audio init requires real AudioContext)
    expect(env.session.state.value).toBe("ready");
  });

  test("config message with unsupported format is ignored with warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    env.mock.lastWs?.simulateMessage(
      JSON.stringify({
        type: "config",
        audioFormat: "mp3",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }),
    );
    expect(warn).toHaveBeenCalledWith("Unsupported server config:", expect.any(String));
    warn.mockRestore();
  });

  test("audio_done message transitions state to listening", async () => {
    env.session.state.value = "speaking" as never;
    env.send({ type: "audio_done" });
    await flush();
    // Without voiceIO, playAudioDone transitions immediately to listening
    expect(env.session.state.value).toBe("listening");
  });

  test("event messages are dispatched to handleEvent", () => {
    env.send({ type: "user_transcript", text: "hello" });
    expect(env.session.state.value).toBe("thinking");
    expect(env.session.messages.value).toEqual([{ role: "user", content: "hello" }]);
  });
});

// ─── Audio chunk edge cases ─────────────────────────────────────────────────

describe("message handling: audio chunk edge cases", () => {
  let env: ReturnType<typeof SetupFn>;

  beforeEach(async () => {
    env = setupSignalsEnv();
    await env.connect();
  });

  afterEach(() => {
    env.session.disconnect();
    env.restore();
  });

  test("rejects audio when state is error", () => {
    env.session.state.value = "error" as never;
    env.mock.lastWs?.simulateMessage(new Uint8Array([1, 2, 3]).buffer);
    expect(env.session.state.value).toBe("error");
  });

  test("transitions to speaking on first audio chunk", () => {
    env.session.state.value = "thinking" as never;
    env.mock.lastWs?.simulateMessage(new Uint8Array([1, 2]).buffer);
    expect(env.session.state.value).toBe("speaking");
  });

  test("stays in speaking state on subsequent audio chunks", () => {
    env.session.state.value = "speaking" as never;
    env.mock.lastWs?.simulateMessage(new Uint8Array([1]).buffer);
    env.mock.lastWs?.simulateMessage(new Uint8Array([2]).buffer);
    expect(env.session.state.value).toBe("speaking");
  });
});

// ─── Event handling ─────────────────────────────────────────────────────────

describe("message handling: events", () => {
  let env: ReturnType<typeof SetupFn>;

  beforeEach(async () => {
    env = setupSignalsEnv();
    await env.connect();
  });

  afterEach(() => {
    env.session.disconnect();
    env.restore();
  });

  test("speech_started sets userUtterance to empty string", () => {
    env.send({ type: "speech_started" });
    expect(env.session.userUtterance.value).toBe("");
  });

  test("speech_stopped is handled without error", () => {
    env.session.state.value = "listening" as never;
    env.send({ type: "speech_stopped" });
    expect(env.session.state.value).toBe("listening");
  });

  test("user_transcript_delta updates userUtterance signal", () => {
    env.session.state.value = "listening" as never;
    env.send({ type: "user_transcript_delta", text: "hello wor", isFinal: false });
    expect(env.session.userUtterance.value).toBe("hello wor");
    expect(env.session.state.value).toBe("listening");
  });

  test("user_transcript adds user message and sets thinking", () => {
    env.session.userUtterance.value = "partial text";
    env.send({ type: "user_transcript", text: "What is the weather?" });
    expect(env.session.state.value).toBe("thinking");
    expect(env.session.userUtterance.value).toBe(null);
    expect(env.session.messages.value).toEqual([{ role: "user", content: "What is the weather?" }]);
  });

  test("agent_transcript_delta accumulates text", () => {
    env.send({ type: "agent_transcript_delta", text: "Hello" });
    expect(env.session.agentUtterance.value).toBe("Hello");
    env.send({ type: "agent_transcript_delta", text: "world" });
    expect(env.session.agentUtterance.value).toBe("Hello world");
  });

  test("agent_transcript clears agentUtterance and adds message", () => {
    env.session.agentUtterance.value = "partial text";
    env.send({ type: "agent_transcript", text: "full response" });
    expect(env.session.agentUtterance.value).toBe(null);
    expect(env.session.messages.value).toEqual([{ role: "assistant", content: "full response" }]);
  });

  test("tool_call adds pending tool call", () => {
    env.session.messages.value = [{ role: "user", content: "do something" }];
    env.send({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "search",
      args: { query: "test" },
    });
    expect(env.session.toolCalls.value).toEqual([
      {
        toolCallId: "tc1",
        toolName: "search",
        args: { query: "test" },
        status: "pending",
        afterMessageIndex: 0,
      },
    ]);
  });

  test("tool_call_done updates matching tool call status", () => {
    env.session.toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "search",
        args: {},
        status: "pending",
        afterMessageIndex: 0,
      },
    ];
    env.send({ type: "tool_call_done", toolCallId: "tc1", result: "found it" });
    expect(env.session.toolCalls.value[0]?.status).toBe("done");
    expect(env.session.toolCalls.value[0]?.result).toBe("found it");
  });

  test("tool_call_done with unknown id is a no-op", () => {
    env.session.toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "search",
        args: {},
        status: "pending",
        afterMessageIndex: 0,
      },
    ];
    env.send({ type: "tool_call_done", toolCallId: "tc_unknown", result: "nope" });
    expect(env.session.toolCalls.value[0]?.status).toBe("pending");
  });

  test("reply_done sets state to listening", () => {
    env.session.state.value = "speaking" as never;
    env.send({ type: "reply_done" });
    expect(env.session.state.value).toBe("listening");
  });

  test("cancelled clears state and flushes audio", () => {
    env.session.state.value = "speaking" as never;
    env.session.userUtterance.value = "partial";
    env.session.agentUtterance.value = "partial agent response";
    env.send({ type: "cancelled" });
    expect(env.session.state.value).toBe("listening");
    expect(env.session.userUtterance.value).toBe(null);
    expect(env.session.agentUtterance.value).toBe(null);
  });

  test("reset clears everything", () => {
    env.session.state.value = "thinking" as never;
    env.session.messages.value = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    env.session.toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "search",
        args: {},
        status: "done",
        result: "x",
        afterMessageIndex: 0,
      },
    ];
    env.session.userUtterance.value = "some partial";
    env.session.error.value = { code: "stt", message: "old error" };
    env.send({ type: "reset" });
    expect(env.session.state.value).toBe("listening");
    expect(env.session.messages.value).toEqual([]);
    expect(env.session.toolCalls.value).toEqual([]);
    expect(env.session.userUtterance.value).toBe(null);
    expect(env.session.error.value).toBe(null);
  });

  test("reset from error state transitions to listening", () => {
    env.session.state.value = "error" as never;
    env.session.error.value = { code: "llm", message: "bad" };
    env.send({ type: "reset" });
    expect(env.session.state.value).toBe("listening");
    expect(env.session.error.value).toBe(null);
  });

  test("error sets error signal and state", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.session.state.value = "listening" as never;
    env.send({ type: "error", code: "stt", message: "Connection lost" });
    expect(env.session.state.value).toBe("error");
    expect(env.session.error.value).toEqual({ code: "stt", message: "Connection lost" });
    errSpy.mockRestore();
  });

  test("error codes are preserved", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const code of [
      "stt",
      "llm",
      "tts",
      "tool",
      "protocol",
      "connection",
      "audio",
      "internal",
    ] as const) {
      env.send({ type: "error", code, message: `${code} error` });
      expect(env.session.error.value?.code).toBe(code);
    }
    errSpy.mockRestore();
  });

  test("unknown event type is silently ignored", () => {
    env.session.state.value = "listening" as never;
    // Unknown event types should be dropped by lenientParse (not even reach handleEvent)
    env.mock.lastWs?.simulateMessage(JSON.stringify({ type: "completely_unknown" }));
    expect(env.session.state.value).toBe("listening");
  });
});

// ─── playAudioDone generation tracking ──────────────────────────────────────

describe("message handling: playAudioDone generation tracking", () => {
  let env: ReturnType<typeof SetupFn>;

  beforeEach(async () => {
    env = setupSignalsEnv();
    await env.connect();
  });

  afterEach(() => {
    env.session.disconnect();
    env.restore();
  });

  test("suppresses stale callback after cancellation", async () => {
    env.session.state.value = "speaking" as never;
    // Send audio_done (starts playAudioDone)
    env.send({ type: "audio_done" });
    // Cancel increments generation before the done() promise resolves
    env.send({ type: "cancelled" });
    expect(env.session.state.value).toBe("listening");
    await flush();
    // State should still be listening (from cancelled), not overwritten by stale callback
    expect(env.session.state.value).toBe("listening");
  });

  test("suppresses stale callback after turn event", async () => {
    env.session.state.value = "speaking" as never;
    // Send audio_done (starts playAudioDone)
    env.send({ type: "audio_done" });
    // A new user_transcript increments generation
    env.send({ type: "user_transcript", text: "new input" });
    expect(env.session.state.value).toBe("thinking");
    await flush();
    // Stale callback should not change state back to listening
    expect(env.session.state.value).toBe("thinking");
  });

  test("audio_done without voiceIO transitions to listening immediately", async () => {
    // Without voiceIO (no audio init), playAudioDone should transition immediately
    env.session.state.value = "speaking" as never;
    env.send({ type: "audio_done" });
    await flush();
    expect(env.session.state.value).toBe("listening");
  });
});
