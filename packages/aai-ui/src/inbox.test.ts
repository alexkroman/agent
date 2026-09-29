// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `createInbox` over a fake socket: the URL it dials, what it answers, and the
 * reconnect loop. The frame-level rules are `inbox-protocol.test.ts`; what is
 * pinned here is what only the socket owner can get wrong — the repeat memory
 * surviving a reconnect (a lost ack's commonest cause is the drop itself), a
 * half-received notice NOT surviving one, and `close()` ending the loop.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type MockWebSocket, recordingWebSocketClass } from "./_session-core-test-utils.ts";
import { createInbox, INBOX_RECONNECT_BASE_MS, INBOX_RECONNECT_MAX_MS } from "./inbox.ts";

const header = (id: string, bytes: number) =>
  JSON.stringify({ type: "notice", id, event: "reminder", bytes, data: { text: "plumber" } });

let sockets: MockWebSocket[] = [];
const WebSocket = recordingWebSocketClass((s) => sockets.push(s));
const last = () => sockets.at(-1);
const replies = (s: MockWebSocket | undefined) =>
  (s?.send.mock.calls ?? []).map((call) => JSON.parse(String(call[0])));

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createInbox", () => {
  test("dials <platformUrl>/inbox with the client, the holder and, when asked, events", () => {
    const inbox = createInbox({
      platformUrl: "https://host/agent",
      client: "kitchen",
      holder: "kitchen-tab1",
      onEvent: () => undefined,
      WebSocket,
    });
    const url = new URL(last()?.url ?? "");
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("wss://host/agent/inbox");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: "kitchen",
      holder: "kitchen-tab1",
      events: "1",
    });
    inbox.close();
  });

  test("delivers a whole notice once and acks it", () => {
    const onNotice = vi.fn();
    const inbox = createInbox({
      platformUrl: "http://h/",
      client: "c",
      holder: "h",
      onNotice,
      WebSocket,
    });
    last()?.simulateOpen();
    last()?.simulateMessage(header("r1", 4));
    last()?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    expect(onNotice).toHaveBeenCalledOnce();
    expect(onNotice.mock.calls[0]?.[0]).toMatchObject({ id: "r1", data: { text: "plumber" } });
    expect(replies(last())).toEqual([{ type: "ack", id: "r1" }]);
    inbox.close();
  });

  test("answers busy while busy() says so, and delivers nothing", () => {
    const onNotice = vi.fn();
    const inbox = createInbox({
      platformUrl: "http://h/",
      client: "c",
      holder: "h",
      busy: () => true,
      onNotice,
      WebSocket,
    });
    last()?.simulateMessage(header("r1", 0));
    expect(replies(last())).toEqual([{ type: "busy", id: "r1" }]);
    expect(onNotice).not.toHaveBeenCalled();
    inbox.close();
  });

  test("routes live frames to onEvent, and without events reads them as nothing", () => {
    const onEvent = vi.fn();
    const frame = JSON.stringify({ type: "session_ended", sessionId: "s1" });
    const withEvents = createInbox({
      platformUrl: "http://h/",
      client: "c",
      holder: "h",
      onEvent,
      WebSocket,
    });
    last()?.simulateMessage(frame);
    expect(onEvent).toHaveBeenCalledWith({ type: "session_ended", sessionId: "s1" });
    withEvents.close();

    const without = createInbox({
      platformUrl: "http://h/",
      client: "c",
      holder: "h",
      onEvent,
      events: false,
      WebSocket,
    });
    expect(new URL(last()?.url ?? "").searchParams.has("events")).toBe(false);
    last()?.simulateMessage(frame);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(replies(last())).toEqual([]);
    without.close();
  });

  test("reports connected, and reconnects on backoff after a drop", () => {
    const inbox = createInbox({ platformUrl: "http://h/", client: "c", holder: "h", WebSocket });
    const seen: boolean[] = [];
    inbox.subscribe(() => seen.push(inbox.connected()));
    last()?.simulateOpen();
    last()?.simulateClose(1006);
    expect(seen).toEqual([true, false]);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(INBOX_RECONNECT_BASE_MS);
    expect(sockets).toHaveLength(2);
    // Failures without an open double the window, up to the cap.
    for (let i = 0; i < 10; i++) {
      last()?.simulateClose(1006);
      vi.advanceTimersByTime(INBOX_RECONNECT_MAX_MS);
    }
    expect(sockets).toHaveLength(12);
    inbox.close();
  });

  test("a repeat after a reconnect is acked, not played twice", () => {
    const onNotice = vi.fn();
    const inbox = createInbox({
      platformUrl: "http://h/",
      client: "c",
      holder: "h",
      onNotice,
      WebSocket,
    });
    last()?.simulateOpen();
    last()?.simulateMessage(header("r1", 0));
    // The ack was lost with the socket; the step resends on the next one.
    last()?.simulateClose(1006);
    vi.advanceTimersByTime(INBOX_RECONNECT_BASE_MS);
    last()?.simulateOpen();
    last()?.simulateMessage(header("r1", 0));
    expect(onNotice).toHaveBeenCalledOnce();
    expect(replies(last())).toEqual([{ type: "ack", id: "r1" }]);
    inbox.close();
  });

  test("a notice cut short by a drop is not finished by the next socket's bytes", () => {
    const onNotice = vi.fn();
    const inbox = createInbox({
      platformUrl: "http://h/",
      client: "c",
      holder: "h",
      onNotice,
      WebSocket,
    });
    last()?.simulateMessage(header("r1", 4));
    last()?.simulateMessage(new Uint8Array([1, 2]));
    last()?.simulateClose(1006);
    vi.advanceTimersByTime(INBOX_RECONNECT_BASE_MS);
    last()?.simulateMessage(new Uint8Array([3, 4]));
    expect(onNotice).not.toHaveBeenCalled();
    expect(replies(last())).toEqual([]);
    inbox.close();
  });

  test("no valid client opens nothing, and a getter that answers later is heard", () => {
    let client: string | undefined;
    const inbox = createInbox({
      platformUrl: "http://h/",
      client: () => client,
      holder: "h",
      WebSocket,
    });
    expect(sockets).toHaveLength(0);
    client = "not valid!";
    vi.advanceTimersByTime(INBOX_RECONNECT_BASE_MS);
    expect(sockets).toHaveLength(0);
    client = "kitchen";
    vi.advanceTimersByTime(INBOX_RECONNECT_MAX_MS);
    expect(new URL(last()?.url ?? "").searchParams.get("client")).toBe("kitchen");
    inbox.close();
  });

  test("close() closes the socket and ends the loop", () => {
    const inbox = createInbox({ platformUrl: "http://h/", client: "c", holder: "h", WebSocket });
    const socket = last();
    socket?.simulateOpen();
    inbox.close();
    expect(socket?.close).toHaveBeenCalled();
    expect(inbox.connected()).toBe(false);
    socket?.simulateClose(1000);
    vi.advanceTimersByTime(INBOX_RECONNECT_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
  });

  test("refuses a holder the server would refuse", () => {
    expect(() =>
      createInbox({ platformUrl: "http://h/", client: "c", holder: "no spaces", WebSocket }),
    ).toThrow(RangeError);
    expect(sockets).toHaveLength(0);
  });
});
