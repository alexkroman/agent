import { describe, expect, test, vi } from "vitest";
import { createS2sTransport } from "./s2s-transport.ts";
import type { TransportCallbacks } from "./types.ts";

function makeCallbacks(): TransportCallbacks {
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

describe("S2sTransport", () => {
  test("start() opens an S2S connection and sends session.update", async () => {
    const send = vi.fn();
    const close = vi.fn();
    const ws = Object.assign(new EventTarget(), {
      readyState: 0,
      send,
      close,
      addEventListener: EventTarget.prototype.addEventListener as unknown as (
        type: string,
        listener: EventListener,
      ) => void,
    }) as unknown as import("../s2s.ts").S2sWebSocket;
    setTimeout(() => {
      (ws as unknown as { readyState: number }).readyState = 1;
      (ws as unknown as EventTarget).dispatchEvent(new Event("open"));
    }, 0);

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks: makeCallbacks(),
      sid: "sid-1",
      agent: "a",
      createWebSocket: () => ws,
    });
    await t.start();
    expect(send).toHaveBeenCalled();
    const firstSend = JSON.parse(send.mock.calls[0]?.[0] as string);
    expect(firstSend.type).toBe("session.update");
    await t.stop();
    expect(close).toHaveBeenCalled();
  });
});
