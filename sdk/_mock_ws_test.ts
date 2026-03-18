import { describe, expect, test, vi } from "vitest";
import { installMockWebSocket, MockWebSocket } from "./_mock_ws.ts";

describe("MockWebSocket", () => {
  test("constructor sets url and CONNECTING state", () => {
    const ws = new MockWebSocket("wss://example.com");
    expect(ws.url).toBe("wss://example.com");
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
  });

  test("auto-transitions to OPEN on microtask", async () => {
    const ws = new MockWebSocket("wss://example.com");
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  test("send records messages in sent array", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    ws.send("hello");
    ws.send("world");
    expect(ws.sent).toEqual(["hello", "world"]);
  });

  test("close sets CLOSED state and dispatches close event", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    const closeHandler = vi.fn();
    ws.addEventListener("close", closeHandler);
    ws.close();
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(closeHandler).toHaveBeenCalled();
  });

  test("simulateMessage dispatches message event", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    const messageHandler = vi.fn();
    ws.addEventListener("message", messageHandler);
    ws.simulateMessage("test data");
    expect(messageHandler).toHaveBeenCalled();
    expect((messageHandler.mock.calls[0]?.[0] as MessageEvent).data).toBe("test data");
  });

  test("open() sets OPEN state", () => {
    const ws = new MockWebSocket("wss://example.com");
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    ws.open();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  test("sentJson filters and parses string messages", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    ws.send(JSON.stringify({ type: "hello" }));
    ws.send(JSON.stringify({ type: "world" }));
    expect(ws.sentJson()).toEqual([{ type: "hello" }, { type: "world" }]);
  });

  test("sentJson ignores binary messages", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    ws.send(JSON.stringify({ type: "hello" }));
    ws.send(new Uint8Array([1, 2, 3]));
    expect(ws.sentJson()).toEqual([{ type: "hello" }]);
  });

  test("disconnect dispatches close event", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    const closeHandler = vi.fn();
    ws.addEventListener("close", closeHandler);
    ws.disconnect();
    expect(closeHandler).toHaveBeenCalled();
  });

  test("error dispatches error event", async () => {
    const ws = new MockWebSocket("wss://example.com");
    await new Promise<void>((r) => queueMicrotask(r));
    const errorHandler = vi.fn();
    ws.addEventListener("error", errorHandler);
    ws.error();
    expect(errorHandler).toHaveBeenCalled();
  });
});

describe("installMockWebSocket", () => {
  test("replaces globalThis.WebSocket", () => {
    const original = globalThis.WebSocket;
    const mock = installMockWebSocket();
    expect(globalThis.WebSocket).not.toBe(original);
    mock.restore();
  });

  test("tracks created sockets", () => {
    const mock = installMockWebSocket();
    const ws = new globalThis.WebSocket("wss://example.com");
    expect(mock.created).toContain(ws);
    mock.restore();
  });

  test("lastWs returns most recent socket", () => {
    const mock = installMockWebSocket();
    new globalThis.WebSocket("wss://example.com/1");
    const ws2 = new globalThis.WebSocket("wss://example.com/2");
    expect(mock.lastWs).toBe(ws2);
    mock.restore();
  });

  test("restore restores original WebSocket", () => {
    const original = globalThis.WebSocket;
    const mock = installMockWebSocket();
    expect(globalThis.WebSocket).not.toBe(original);
    mock.restore();
    expect(globalThis.WebSocket).toBe(original);
  });
});
