// Copyright 2026 the AAI authors. MIT license.
/**
 * `MockWebSocket`, the browser-shaped socket the session and telephony specs
 * drive: it opens itself on the next microtask, records what is sent, and
 * dispatches the events a spec simulates.
 */

import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { flush } from "./_timing-test-utils.ts";

describe("MockWebSocket", () => {
  test("opens itself on the next microtask, firing `open` once", async () => {
    const ws = new MockWebSocket(new URL("wss://example.test/session"));
    const opened = vi.fn();
    ws.addEventListener("open", opened);
    expect(ws.url).toBe("wss://example.test/session");
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    await flush();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test("a socket closed before the microtask never opens", async () => {
    const ws = new MockWebSocket("wss://example.test");
    const opened = vi.fn();
    ws.addEventListener("open", opened);
    ws.close();
    await flush();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(opened).not.toHaveBeenCalled();
  });

  test("records sends, and `sentJson` parses the text frames only", () => {
    const ws = new MockWebSocket("wss://example.test");
    ws.send(JSON.stringify({ type: "a" }));
    ws.send(new Uint8Array([1, 2]));
    ws.send(JSON.stringify({ type: "b" }));
    expect(ws.sent).toHaveLength(3);
    expect(ws.sentJson()).toEqual([{ type: "a" }, { type: "b" }]);
  });

  test("dispatches simulated messages, closes with their code, and errors", () => {
    const ws = new MockWebSocket("wss://example.test");
    const messages: unknown[] = [];
    const codes: (number | undefined)[] = [];
    const errored = vi.fn();
    ws.addEventListener("message", (event) => messages.push(event.data));
    ws.addEventListener("close", (event) => codes.push(event.code));
    ws.addEventListener("error", errored);

    ws.msg("hello");
    ws.simulateMessage("again");
    ws.disconnect(4001);
    ws.close();
    ws.error();

    expect(messages).toEqual(["hello", "again"]);
    // `disconnect` is the PEER closing: it fires `close` without touching readyState.
    expect(codes).toEqual([4001, 1000]);
    expect(errored).toHaveBeenCalledTimes(1);
  });

  test("`disconnect` leaves readyState alone; `close` sets it CLOSED", () => {
    const ws = new MockWebSocket("wss://example.test");
    ws.open();
    ws.disconnect();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    ws.close(1001);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});
