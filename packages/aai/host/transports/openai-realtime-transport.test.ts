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
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "OpenAI-Beta": "realtime=v1",
        }),
      }),
    );

    expect(fake.sent.length).toBe(1);
    const first = fake.sent[0];
    if (first === undefined) throw new Error("expected one send");
    const msg = JSON.parse(first);
    expect(msg.type).toBe("session.update");
    expect(msg.session.voice).toBe("cedar");
    expect(msg.session.instructions).toBe("Be terse.");
    expect(msg.session.input_audio_format).toBe("pcm16");
    expect(msg.session.output_audio_format).toBe("pcm16");
    expect(msg.session.modalities).toEqual(["audio", "text"]);
    expect(msg.session.input_audio_transcription).toEqual({ model: "whisper-1" });
    expect(msg.session.turn_detection.type).toBe("server_vad");
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

  test("response.audio.delta calls onAudioChunk with decoded bytes", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const audio = Buffer.from([5, 6, 7, 8]).toString("base64");
    fake.fire("message", {
      data: JSON.stringify({ type: "response.audio.delta", delta: audio }),
    });
    expect(cbs.onAudioChunk).toHaveBeenCalledTimes(1);
    expect(cbs.onAudioChunk).toHaveBeenCalledWith(new Uint8Array([5, 6, 7, 8]));
  });

  test("response.audio.done calls onAudioDone", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", { data: JSON.stringify({ type: "response.audio.done" }) });
    expect(cbs.onAudioDone).toHaveBeenCalledTimes(1);
  });
});
