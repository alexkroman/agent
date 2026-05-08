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
