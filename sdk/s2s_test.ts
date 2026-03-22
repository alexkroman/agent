import { describe, expect, test, vi } from "vitest";
import { connectS2s, wrapOnStyleWebSocket } from "./s2s.ts";

// Minimal on-style WebSocket stub (matches the `ws` npm package interface)
function createOnStyleStub() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };
}

describe("wrapOnStyleWebSocket", () => {
  test("readyState reflects the underlying WebSocket state", () => {
    const raw = createOnStyleStub();
    raw.readyState = 0; // CONNECTING
    const wrapped = wrapOnStyleWebSocket(raw);

    expect(wrapped.readyState).toBe(0);

    // Simulate open — readyState should update live
    raw.readyState = 1;
    expect(wrapped.readyState).toBe(1);

    raw.readyState = 3; // CLOSED
    expect(wrapped.readyState).toBe(3);
  });

  test("dispatches open event", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    const onOpen = vi.fn();
    wrapped.addEventListener("open", onOpen);

    raw.emit("open");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("dispatches message event with data", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    const onMessage = vi.fn();
    wrapped.addEventListener("message", onMessage);

    const payload = Buffer.from('{"type":"session.updated"}');
    raw.emit("message", payload);

    expect(onMessage).toHaveBeenCalledOnce();
    const ev = onMessage.mock.calls[0]?.[0] as MessageEvent;
    expect(ev.data).toBe(payload);
  });

  test("send delegates to underlying WebSocket", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    wrapped.send('{"type":"test"}');
    expect(raw.send).toHaveBeenCalledWith('{"type":"test"}');
  });

  test("close delegates to underlying WebSocket", () => {
    const raw = createOnStyleStub();
    const wrapped = wrapOnStyleWebSocket(raw);
    wrapped.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });
});

describe("connectS2s", () => {
  test("sends session.update after open when readyState is OPEN", async () => {
    const raw = createOnStyleStub();
    const createWebSocket = (_url: string, _opts: { headers: Record<string, string> }) => {
      // Simulate async open
      setTimeout(() => {
        raw.readyState = 1;
        raw.emit("open");
      }, 0);
      return wrapOnStyleWebSocket(raw);
    };

    const handle = await connectS2s({
      apiKey: "test-key",
      config: { wssUrl: "wss://fake", inputSampleRate: 16000, outputSampleRate: 16000 },
      createWebSocket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    handle.updateSession({
      system_prompt: "test",
      tools: [],
    });

    expect(raw.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(raw.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("session.update");
    expect(sent.session.system_prompt).toBe("test");
  });
});
