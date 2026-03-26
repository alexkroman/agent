// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { ClientHandler, type Reactive } from "./session.ts";
import type { AgentState, Message, SessionError, ToolCallInfo } from "./types.ts";

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
  const messages = reactive<Message[]>([]);
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

describe("ClientHandler event handling", () => {
  test("speech_started sets userUtterance to empty string", () => {
    const { target, userUtterance } = createTarget();
    target.event({ type: "speech_started" });
    expect(userUtterance.value).toBe("");
  });

  test("transcript partial updates userUtterance signal", () => {
    const { target, userUtterance, state } = createTarget();
    state.value = "listening";
    target.event({ type: "transcript", text: "hello wor", isFinal: false });
    expect(userUtterance.value).toBe("hello wor");
    expect(state.value).toBe("listening");
  });

  test("transcript final updates userUtterance signal", () => {
    const { target, userUtterance } = createTarget();
    target.event({ type: "transcript", text: "hello world", isFinal: true, turnOrder: 1 });
    expect(userUtterance.value).toBe("hello world");
  });

  test("turn adds user message and sets thinking", () => {
    const { target, state, messages, userUtterance } = createTarget();
    userUtterance.value = "partial text";
    target.event({ type: "turn", text: "What is the weather?" });
    expect(state.value).toBe("thinking");
    expect(userUtterance.value).toBe(null);
    expect(messages.value).toEqual([{ role: "user", content: "What is the weather?" }]);
  });

  test("chat adds assistant message without changing state", () => {
    const { target, state, messages } = createTarget();
    target.event({ type: "chat", text: "It's sunny today" });
    expect(state.value).toBe("connecting");
    expect(messages.value).toEqual([{ role: "assistant", content: "It's sunny today" }]);
  });

  test("tts_done sets state to listening", () => {
    const { target, state } = createTarget();
    state.value = "speaking";
    target.event({ type: "tts_done" });
    expect(state.value).toBe("listening");
  });

  test("cancelled flushes audio and sets listening", () => {
    const { target, state, userUtterance, wasFlushed } = createTarget();
    state.value = "speaking";
    userUtterance.value = "partial";
    target.event({ type: "cancelled" });
    expect(state.value).toBe("listening");
    expect(userUtterance.value).toBe(null);
    expect(wasFlushed()).toBe(true);
  });

  test("reset clears all state and sets listening", () => {
    const { target, state, messages, userUtterance, error } = createTarget();
    state.value = "thinking";
    messages.value = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    userUtterance.value = "some partial";
    error.value = { code: "stt", message: "old error" };
    target.event({ type: "reset" });
    expect(state.value).toBe("listening");
    expect(messages.value).toEqual([]);
    expect(userUtterance.value).toBe(null);
    expect(error.value).toBe(null);
  });

  test("reset from error state transitions to listening", () => {
    const { target, state, error } = createTarget();
    state.value = "error";
    error.value = { code: "llm", message: "bad" };
    target.event({ type: "reset" });
    expect(state.value).toBe("listening");
    expect(error.value).toBe(null);
  });

  test("error sets error signal and state", () => {
    const { target, state, error } = createTarget();
    state.value = "listening";
    target.event({ type: "error", code: "stt", message: "Connection lost" });
    expect(state.value).toBe("error");
    expect(error.value).toEqual({ code: "stt", message: "Connection lost" });
  });

  test("error codes are preserved", () => {
    const { target, error } = createTarget();
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
      target.event({ type: "error", code, message: `${code} error` });
      expect(error.value?.code).toBe(code);
    }
  });

  test("playAudioChunk delivers audio while speaking", () => {
    const { target, state, chunks } = createTarget();
    state.value = "speaking";
    target.playAudioChunk(new Uint8Array([1, 2, 3, 4]));
    expect(chunks().length).toBe(1);
  });

  test("playAudioDone transitions to listening after playback completes", async () => {
    const { target, state, wasDone } = createTarget();
    state.value = "speaking";
    target.playAudioDone();
    await new Promise((r) => setTimeout(r, 0));
    expect(wasDone()).toBe(true);
    expect(state.value).toBe("listening");
  });
});
