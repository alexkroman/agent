// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { ClientHandler } from "./client-handler.ts";
import { flush } from "./lib/test-utils.ts";
import type { AgentState, ChatMessage, Reactive, SessionError, ToolCallInfo } from "./types.ts";

function reactive<T>(initial: T): Reactive<T> {
  return { value: initial };
}

function makeVoiceIO(overrides?: Partial<Record<string, (...args: never[]) => unknown>>) {
  let flushed = false;
  const chunks: ArrayBuffer[] = [];
  let doneCalled = false;
  return {
    factory: () => ({
      enqueue(buf: ArrayBuffer) {
        chunks.push(buf);
      },
      done() {
        doneCalled = true;
        return Promise.resolve();
      },
      flush() {
        flushed = true;
      },
      close() {
        return Promise.resolve();
      },
      async [Symbol.asyncDispose]() {
        /* noop */
      },
      ...overrides,
    }),
    wasFlushed: () => flushed,
    chunks: () => chunks,
    wasDone: () => doneCalled,
  };
}

function createTarget(voiceOverrides?: Partial<Record<string, (...args: never[]) => unknown>>) {
  const state = reactive<AgentState>("connecting");
  const messages = reactive<ChatMessage[]>([]);
  const toolCalls = reactive<ToolCallInfo[]>([]);
  const userUtterance = reactive<string | null>(null);
  const agentUtterance = reactive<string | null>(null);
  const error = reactive<SessionError | null>(null);
  const io = makeVoiceIO(voiceOverrides);

  const target = new ClientHandler({
    state,
    messages,
    toolCalls,
    userUtterance,
    agentUtterance,
    error,
    voiceIO: io.factory,
    batch: (fn) => fn(),
  });

  return { target, state, messages, toolCalls, userUtterance, agentUtterance, error, ...io };
}

describe("ClientHandler.handleMessage", () => {
  test("binary ArrayBuffer dispatches audio chunk", () => {
    const { target, state, chunks } = createTarget();
    state.value = "listening";
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = target.handleMessage(buf);
    expect(result).toBe(null);
    expect(chunks().length).toBe(1);
    expect(state.value).toBe("speaking");
  });

  test("malformed JSON returns null silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { target, state } = createTarget();
    state.value = "listening";
    const result = target.handleMessage("not valid json {{{");
    expect(result).toBe(null);
    expect(state.value).toBe("listening");
    warn.mockRestore();
  });

  test("valid JSON that fails schema validation returns null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { target, state } = createTarget();
    state.value = "listening";
    const result = target.handleMessage(JSON.stringify({ type: "unknown_event_type", data: 123 }));
    expect(result).toBe(null);
    expect(state.value).toBe("listening");
    expect(warn).toHaveBeenCalledWith("Ignoring invalid server message:", expect.any(String));
    warn.mockRestore();
  });

  test("config message returns parsed ReadyConfig", () => {
    const { target } = createTarget();
    const result = target.handleMessage(
      JSON.stringify({
        type: "config",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }),
    );
    expect(result).toEqual({
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
  });

  test("config message with unsupported format returns null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { target } = createTarget();
    const result = target.handleMessage(
      JSON.stringify({
        type: "config",
        audioFormat: "mp3",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }),
    );
    expect(result).toBe(null);
    expect(warn).toHaveBeenCalledWith("Unsupported server config:", expect.any(String));
    warn.mockRestore();
  });

  test("audio_done message calls playAudioDone", async () => {
    const { target, state, wasDone } = createTarget();
    state.value = "speaking";
    target.handleMessage(JSON.stringify({ type: "audio_done" }));
    await flush();
    expect(wasDone()).toBe(true);
    expect(state.value).toBe("listening");
  });

  test("event messages are dispatched to event()", () => {
    const { target, state, messages } = createTarget();
    target.handleMessage(JSON.stringify({ type: "turn", text: "hello" }));
    expect(state.value).toBe("thinking");
    expect(messages.value).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("ClientHandler.playAudioChunk edge cases", () => {
  test("rejects audio when state is error", () => {
    const { target, state, chunks } = createTarget();
    state.value = "error";
    target.playAudioChunk(new Uint8Array([1, 2, 3]));
    expect(chunks().length).toBe(0);
    expect(state.value).toBe("error");
  });

  test("transitions to speaking on first chunk", () => {
    const { target, state } = createTarget();
    state.value = "thinking";
    target.playAudioChunk(new Uint8Array([1, 2]));
    expect(state.value).toBe("speaking");
  });

  test("stays in speaking state on subsequent chunks", () => {
    const { target, state } = createTarget();
    state.value = "speaking";
    target.playAudioChunk(new Uint8Array([1]));
    target.playAudioChunk(new Uint8Array([2]));
    expect(state.value).toBe("speaking");
  });
});

describe("ClientHandler.playAudioDone generation tracking", () => {
  test("suppresses stale callback after cancellation", async () => {
    const { target, state } = createTarget();
    state.value = "speaking";
    // Start playback done (captures current generation)
    target.playAudioDone();
    // Cancel increments generation before the done() promise resolves
    target.event({ type: "cancelled" });
    expect(state.value).toBe("listening");
    // Let the done() promise resolve
    await flush();
    // State should still be listening (from cancelled), not overwritten by stale callback
    expect(state.value).toBe("listening");
  });

  test("suppresses stale callback after turn event", async () => {
    const { target, state } = createTarget();
    state.value = "speaking";
    target.playAudioDone();
    // A new turn increments generation
    target.event({ type: "turn", text: "new input" });
    expect(state.value).toBe("thinking");
    await flush();
    // Stale callback should not change state back to listening
    expect(state.value).toBe("thinking");
  });

  test("transitions to listening when no voiceIO is available", () => {
    const state = reactive<AgentState>("speaking");
    const messages = reactive<ChatMessage[]>([]);
    const toolCalls = reactive<ToolCallInfo[]>([]);
    const userUtterance = reactive<string | null>(null);
    const agentUtterance = reactive<string | null>(null);
    const error = reactive<SessionError | null>(null);

    const target = new ClientHandler({
      state,
      messages,
      toolCalls,
      userUtterance,
      agentUtterance,
      error,
      voiceIO: () => null,
      batch: (fn) => fn(),
    });

    target.playAudioDone();
    expect(state.value).toBe("listening");
  });

  test("handles voiceIO.done() rejection gracefully", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { target, state } = createTarget({
      done() {
        return Promise.reject(new Error("playback failed"));
      },
    });
    state.value = "speaking";
    target.playAudioDone();
    await flush();
    expect(warn).toHaveBeenCalledWith("Audio playback done failed:", expect.any(Error));
    warn.mockRestore();
  });
});

describe("ClientHandler.event edge cases", () => {
  test("chat_delta appends to existing agentUtterance", () => {
    const { target, agentUtterance } = createTarget();
    target.event({ type: "chat_delta", text: "Hello" });
    expect(agentUtterance.value).toBe("Hello");
    target.event({ type: "chat_delta", text: "world" });
    expect(agentUtterance.value).toBe("Hello world");
  });

  test("chat clears agentUtterance and adds message", () => {
    const { target, agentUtterance, messages } = createTarget();
    agentUtterance.value = "partial text";
    target.event({ type: "chat", text: "full response" });
    expect(agentUtterance.value).toBe(null);
    expect(messages.value).toEqual([{ role: "assistant", content: "full response" }]);
  });

  test("tool_call_start adds pending tool call", () => {
    const { target, toolCalls, messages } = createTarget();
    messages.value = [{ role: "user", content: "do something" }];
    target.event({
      type: "tool_call_start",
      toolCallId: "tc1",
      toolName: "search",
      args: { query: "test" },
    });
    expect(toolCalls.value).toEqual([
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
    const { target, toolCalls } = createTarget();
    toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "search",
        args: {},
        status: "pending",
        afterMessageIndex: 0,
      },
    ];
    target.event({ type: "tool_call_done", toolCallId: "tc1", result: "found it" });
    expect(toolCalls.value[0]?.status).toBe("done");
    expect(toolCalls.value[0]?.result).toBe("found it");
  });

  test("tool_call_done with unknown id is a no-op", () => {
    const { target, toolCalls } = createTarget();
    toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "search",
        args: {},
        status: "pending",
        afterMessageIndex: 0,
      },
    ];
    target.event({ type: "tool_call_done", toolCallId: "tc_unknown", result: "nope" });
    expect(toolCalls.value[0]?.status).toBe("pending");
  });

  test("cancelled clears agentUtterance too", () => {
    const { target, agentUtterance } = createTarget();
    agentUtterance.value = "partial agent response";
    target.event({ type: "cancelled" });
    expect(agentUtterance.value).toBe(null);
  });

  test("reset clears toolCalls", () => {
    const { target, toolCalls } = createTarget();
    toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "search",
        args: {},
        status: "done",
        result: "x",
        afterMessageIndex: 0,
      },
    ];
    target.event({ type: "reset" });
    expect(toolCalls.value).toEqual([]);
  });

  test("speech_stopped is handled without error", () => {
    const { target, state } = createTarget();
    state.value = "listening";
    target.event({ type: "speech_stopped" });
    expect(state.value).toBe("listening");
  });

  test("unknown event type is silently ignored", () => {
    const { target, state } = createTarget();
    state.value = "listening";
    // Cast to bypass TypeScript — exercises the default: break path
    target.event({ type: "completely_unknown" } as never);
    expect(state.value).toBe("listening");
  });
});
