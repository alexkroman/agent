import { describe, expect, test, vi } from "vitest";
import { installMockWebSocket, MockWebSocket } from "./_mock-ws.ts";

describe("MockWebSocket", () => {
  test("starts in CONNECTING state", () => {
    const ws = new MockWebSocket("wss://example.com");
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
  });

  test("auto-opens via microtask", async () => {
    const ws = new MockWebSocket("wss://example.com");
    const onOpen = vi.fn();
    ws.addEventListener("open", onOpen);

    await new Promise<void>((r) => queueMicrotask(() => r()));

    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("does not auto-open if already closed before microtask fires", async () => {
    const ws = new MockWebSocket("wss://example.com");
    ws.close();
    const onOpen = vi.fn();
    ws.addEventListener("open", onOpen);

    await new Promise<void>((r) => queueMicrotask(() => r()));

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("stores URL as string", () => {
    const ws = new MockWebSocket("wss://example.com/path");
    expect(ws.url).toBe("wss://example.com/path");
  });

  test("stores URL from URL object", () => {
    const ws = new MockWebSocket(new URL("wss://example.com/path"));
    expect(ws.url).toBe("wss://example.com/path");
  });

  test("send() records messages in sent array", () => {
    const ws = new MockWebSocket("wss://example.com");
    ws.send("hello");
    ws.send("world");
    expect(ws.sent).toEqual(["hello", "world"]);
  });

  test("send() records binary messages", () => {
    const ws = new MockWebSocket("wss://example.com");
    const buf = new Uint8Array([1, 2, 3]);
    ws.send(buf);
    expect(ws.sent).toEqual([buf]);
  });

  test("sentJson() returns parsed JSON from string messages", () => {
    const ws = new MockWebSocket("wss://example.com");
    ws.send(JSON.stringify({ type: "a" }));
    ws.send(JSON.stringify({ type: "b", val: 42 }));
    expect(ws.sentJson()).toEqual([{ type: "a" }, { type: "b", val: 42 }]);
  });

  test("sentJson() filters out binary messages", () => {
    const ws = new MockWebSocket("wss://example.com");
    ws.send(JSON.stringify({ type: "text" }));
    ws.send(new Uint8Array([1, 2, 3]));
    ws.send(JSON.stringify({ type: "more" }));
    expect(ws.sentJson()).toEqual([{ type: "text" }, { type: "more" }]);
  });

  test("close() sets readyState to CLOSED and dispatches close event", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onClose = vi.fn();
    ws.addEventListener("close", onClose);

    ws.close();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(onClose).toHaveBeenCalledOnce();
    const ev = onClose.mock.calls[0]?.[0] as Event & { code: number };
    expect(ev.code).toBe(1000);
  });

  test("close() with custom code", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onClose = vi.fn();
    ws.addEventListener("close", onClose);

    ws.close(4001);

    const ev = onClose.mock.calls[0]?.[0] as Event & { code: number };
    expect(ev.code).toBe(4001);
  });

  test("simulateMessage() dispatches message event", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onMessage = vi.fn();
    ws.addEventListener("message", onMessage);

    ws.simulateMessage('{"type":"test"}');

    expect(onMessage).toHaveBeenCalledOnce();
    const ev = onMessage.mock.calls[0]?.[0] as MessageEvent;
    expect(ev.data).toBe('{"type":"test"}');
  });

  test("simulateMessage() works with binary data", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onMessage = vi.fn();
    ws.addEventListener("message", onMessage);

    const buf = new ArrayBuffer(4);
    ws.simulateMessage(buf);

    const ev = onMessage.mock.calls[0]?.[0] as MessageEvent;
    expect(ev.data).toBe(buf);
  });

  test("msg() is alias for simulateMessage", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onMessage = vi.fn();
    ws.addEventListener("message", onMessage);

    ws.msg("hello");

    expect(onMessage).toHaveBeenCalledOnce();
  });

  test("open() sets readyState to OPEN and dispatches open event", () => {
    const ws = new MockWebSocket("wss://example.com");
    ws.readyState = MockWebSocket.CLOSED;
    const onOpen = vi.fn();
    ws.addEventListener("open", onOpen);

    ws.open();

    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("disconnect() dispatches close event", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onClose = vi.fn();
    ws.addEventListener("close", onClose);

    ws.disconnect(1001);

    expect(onClose).toHaveBeenCalledOnce();
    const ev = onClose.mock.calls[0]?.[0] as Event & { code: number };
    expect(ev.code).toBe(1001);
  });

  test("disconnect() defaults to code 1000", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onClose = vi.fn();
    ws.addEventListener("close", onClose);

    ws.disconnect();

    const ev = onClose.mock.calls[0]?.[0] as Event & { code: number };
    expect(ev.code).toBe(1000);
  });

  test("error() dispatches error event", () => {
    const ws = new MockWebSocket("wss://example.com");
    const onError = vi.fn();
    ws.addEventListener("error", onError);

    ws.error();

    expect(onError).toHaveBeenCalledOnce();
  });

  test("static constants match WebSocket spec", () => {
    expect(MockWebSocket.CONNECTING).toBe(0);
    expect(MockWebSocket.OPEN).toBe(1);
    expect(MockWebSocket.CLOSING).toBe(2);
    expect(MockWebSocket.CLOSED).toBe(3);
  });
});

describe("installMockWebSocket", () => {
  test("replaces globalThis.WebSocket and tracks created instances", () => {
    using mock = installMockWebSocket();
    const ws = new WebSocket("wss://test.com");
    expect(mock.created).toHaveLength(1);
    expect(mock.created[0]).toBe(ws);
  });

  test("lastWs returns the most recently created instance", () => {
    using mock = installMockWebSocket();
    expect(mock.lastWs).toBeNull();
    new WebSocket("wss://first.com");
    const second = new WebSocket("wss://second.com");
    expect(mock.lastWs).toBe(second);
  });

  test("restore() restores original WebSocket", () => {
    const originalWs = globalThis.WebSocket;
    const mock = installMockWebSocket();
    expect(globalThis.WebSocket).not.toBe(originalWs);
    mock.restore();
    expect(globalThis.WebSocket).toBe(originalWs);
  });

  test("using declaration restores original WebSocket on scope exit", () => {
    const originalWs = globalThis.WebSocket;
    {
      using _mock = installMockWebSocket();
      expect(globalThis.WebSocket).not.toBe(originalWs);
    }
    expect(globalThis.WebSocket).toBe(originalWs);
  });
});
