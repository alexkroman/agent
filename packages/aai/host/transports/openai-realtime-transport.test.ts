// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import {
  createOpenaiRealtimeTransport,
  type OpenaiRealtimeWebSocket,
} from "./openai-realtime-transport.ts";
import type { TransportCallbacks } from "./types.ts";

function noopCallbacks(): TransportCallbacks {
  return {
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
  };
}

type Listener = (ev: unknown) => void;

function makeFakeWs() {
  const listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  const sent: string[] = [];
  const ws: OpenaiRealtimeWebSocket = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
    close() {
      for (const fn of listeners.close ?? []) fn({ code: 1000, reason: "" });
    },
    addEventListener(type: string, fn: Listener) {
      (listeners[type] ?? []).push(fn);
    },
  } as OpenaiRealtimeWebSocket;
  return Object.assign(ws, {
    fire(type: "open" | "message" | "close" | "error", ev?: unknown) {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
    sent,
  });
}

function startedTransport() {
  const fake = makeFakeWs();
  const cbs = noopCallbacks();
  const transport = createOpenaiRealtimeTransport({
    apiKey: "sk",
    options: {},
    sessionConfig: { systemPrompt: "" },
    toolSchemas: [],
    toolChoice: "auto",
    callbacks: cbs,
    sid: "s",
    agent: "a",
    createWebSocket: () => fake,
    logger: silentLogger,
  });
  const ready = transport.start();
  fake.fire("open");
  return { fake, cbs, transport, ready };
}

describe("openai-realtime-transport: connect and session.update", () => {
  test("opens WS with auth headers and sends session.update on open", async () => {
    const fake = makeFakeWs();
    const createWs = vi.fn(() => fake);

    const transport = createOpenaiRealtimeTransport({
      apiKey: "sk-test",
      options: { model: "gpt-realtime", voice: "cedar" },
      sessionConfig: {
        systemPrompt: "Be terse.",
        greeting: "Hi.",
        tools: [],
      },
      toolSchemas: [
        {
          type: "function",
          name: "lookup",
          description: "look up something",
          parameters: { type: "object", properties: {} },
        },
      ],
      toolChoice: "auto",
      callbacks: noopCallbacks(),
      sid: "sid-1",
      agent: "test-agent",
      createWebSocket: createWs,
      logger: silentLogger,
    });

    const startP = transport.start();
    fake.fire("open");
    await startP;

    expect(createWs).toHaveBeenCalledWith(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      }),
    );

    expect(fake.sent.length).toBe(1);
    const first = fake.sent[0];
    if (first === undefined) throw new Error("expected one send");
    const msg = JSON.parse(first);
    expect(msg.type).toBe("session.update");
    expect(msg.session.type).toBe("realtime");
    expect(msg.session.output_modalities).toEqual(["audio"]);
    expect(msg.session.instructions).toBe("Be terse.");
    expect(msg.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(msg.session.audio.input.turn_detection.type).toBe("server_vad");
    expect(msg.session.audio.input.transcription).toEqual({ model: "whisper-1" });
    expect(msg.session.audio.output.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(msg.session.audio.output.voice).toBe("cedar");
    expect(msg.session.tools).toEqual([
      expect.objectContaining({ type: "function", name: "lookup" }),
    ]);
    expect(msg.session.tool_choice).toBe("auto");
  });
});

describe("audio in/out", () => {
  test("sendUserAudio sends input_audio_buffer.append with base64 payload", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0;
    transport.sendUserAudio(new Uint8Array([1, 2, 3, 4]));
    expect(fake.sent.length).toBe(1);
    const first = fake.sent[0];
    if (first === undefined) throw new Error("expected one send");
    const msg = JSON.parse(first);
    expect(msg.type).toBe("input_audio_buffer.append");
    expect(typeof msg.audio).toBe("string");
    expect(Buffer.from(msg.audio, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test.each([
    ["response.audio.delta"],
    ["response.output_audio.delta"],
  ])("%s calls onAudioChunk with decoded bytes", async (type) => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const audio = Buffer.from([5, 6, 7, 8]).toString("base64");
    fake.fire("message", { data: JSON.stringify({ type, delta: audio }) });
    expect(cbs.onAudioChunk).toHaveBeenCalledTimes(1);
    expect(cbs.onAudioChunk).toHaveBeenCalledWith(new Uint8Array([5, 6, 7, 8]));
  });

  test.each([
    ["response.audio.done"],
    ["response.output_audio.done"],
  ])("%s calls onAudioDone", async (type) => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", { data: JSON.stringify({ type }) });
    expect(cbs.onAudioDone).toHaveBeenCalledTimes(1);
  });
});

describe("VAD, user transcript, reply lifecycle, agent transcript", () => {
  test("speech_started/stopped routed to callbacks", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });
    fake.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }),
    });
    expect(cbs.onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(cbs.onSpeechStopped).toHaveBeenCalledTimes(1);
  });

  test("user transcription completed routes to onUserTranscript", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello world",
      }),
    });
    expect(cbs.onUserTranscript).toHaveBeenCalledWith("hello world");
  });

  test("response.created → onReplyStarted; response.done → onReplyDone", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
    });
    expect(cbs.onReplyStarted).toHaveBeenCalledWith("resp_1");
    fake.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    expect(cbs.onReplyDone).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["response.audio_transcript", "legacy"],
    ["response.output_audio_transcript", "GA"],
  ])("agent transcript (%s): deltas accumulated, emitted on done", async (prefix) => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const item_id = "item_x";
    fake.fire("message", {
      data: JSON.stringify({ type: `${prefix}.delta`, item_id, delta: "Hi " }),
    });
    fake.fire("message", {
      data: JSON.stringify({ type: `${prefix}.delta`, item_id, delta: "there." }),
    });
    expect(cbs.onAgentTranscript).not.toHaveBeenCalled();
    fake.fire("message", {
      data: JSON.stringify({ type: `${prefix}.done`, item_id }),
    });
    expect(cbs.onAgentTranscript).toHaveBeenCalledWith("Hi there.", false);
  });

  test("agent transcript: done with no buffered deltas does not emit", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.audio_transcript.done",
        item_id: "empty",
      }),
    });
    expect(cbs.onAgentTranscript).not.toHaveBeenCalled();
  });
});

describe("tool calls", () => {
  test("function_call_arguments deltas accumulate; .done emits onToolCall", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const item_id = "item_t";
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_item.added",
        item: { id: item_id, type: "function_call", name: "lookup", call_id: "call_1" },
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id,
        delta: '{"q":',
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id,
        delta: '"hi"}',
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id,
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"hi"}',
      }),
    });
    expect(cbs.onToolCall).toHaveBeenCalledWith("call_1", "lookup", { q: "hi" });
  });

  test("done with empty/invalid args still calls onToolCall with {}", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const item_id = "item_e";
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_item.added",
        item: { id: item_id, type: "function_call", name: "noop", call_id: "call_e" },
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id,
        call_id: "call_e",
        name: "noop",
        arguments: "",
      }),
    });
    expect(cbs.onToolCall).toHaveBeenCalledWith("call_e", "noop", {});
  });

  test("sendToolResult sends conversation.item.create + response.create", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0; // drop session.update
    transport.sendToolResult("call_1", '{"ok":true}');
    expect(fake.sent.length).toBe(2);
    const m1 = JSON.parse(fake.sent[0] ?? "{}");
    expect(m1.type).toBe("conversation.item.create");
    expect(m1.item.type).toBe("function_call_output");
    expect(m1.item.call_id).toBe("call_1");
    expect(m1.item.output).toBe('{"ok":true}');
    const m2 = JSON.parse(fake.sent[1] ?? "{}");
    expect(m2.type).toBe("response.create");
  });
});

describe("cancel, error, close", () => {
  test("cancelReply sends response.cancel only when a reply is in flight", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0;
    // No reply yet — cancel should be a no-op
    transport.cancelReply();
    expect(fake.sent.length).toBe(0);

    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r1" } }),
    });
    transport.cancelReply();
    expect(fake.sent.length).toBe(1);
    expect(JSON.parse(fake.sent[0] ?? "{}").type).toBe("response.cancel");
  });

  test("cancelReply also fires onCancelled", async () => {
    const { fake, cbs, transport, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r2" } }),
    });
    transport.cancelReply();
    expect(cbs.onCancelled).toHaveBeenCalledTimes(1);
  });

  test("error event routes to onError with internal code", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "error", error: { message: "boom" } }),
    });
    expect(cbs.onError).toHaveBeenCalledWith("internal", "boom");
  });

  test("error event with missing message uses fallback", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", { data: JSON.stringify({ type: "error" }) });
    expect(cbs.onError).toHaveBeenCalledWith("internal", expect.any(String));
  });

  test("unexpected close routes to onError with connection code", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("close", { code: 1006, reason: "" });
    expect(cbs.onError).toHaveBeenCalledWith("connection", expect.stringMatching(/closed/i));
  });
});
