// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S fuzz's fake link: the socket's lifecycle is the WebSocket one (no
 * frame reaches a socket that is not OPEN, a close is dispatched once), and the
 * ledgers the oracles read record what the code under test sent.
 */

import { describe, expect, test, vi } from "vitest";
import { flush } from "../_timing-test-utils.ts";
import {
  createFakeS2sLink,
  FATAL_CODES,
  type FakeS2sSocket,
  TRANSIENT_CODES,
} from "./_s2s-fuzz-model.ts";

function connect(link: ReturnType<typeof createFakeS2sLink>): FakeS2sSocket {
  link.createWebSocket("wss://s2s.test", { headers: {} });
  const sock = link.current();
  if (sock === undefined) throw new Error("no socket created");
  return sock;
}

describe("the fake socket", () => {
  test("starts CONNECTING, and a send before open is recorded as a bug, not delivered", () => {
    const link = createFakeS2sLink();
    const sock = connect(link);
    expect(link.unopened()).toBe(sock);
    sock.send(JSON.stringify({ type: "early" }));
    expect(sock.sent).toEqual([]);
    expect(sock.sentWhileNotOpen).toEqual(['{"type":"early"}']);

    const opened = vi.fn();
    sock.addEventListener("open", opened);
    sock.open();
    sock.open();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(link.unopened()).toBeUndefined();
    sock.send(JSON.stringify({ type: "hello" }));
    expect(sock.sent).toEqual([{ type: "hello" }]);
  });

  test("delivers inbound frames only while OPEN", () => {
    const sock = connect(createFakeS2sLink());
    const messages: unknown[] = [];
    sock.addEventListener("message", (event) => messages.push(event.data));
    sock.deliver({ type: "dropped" });
    sock.open();
    sock.deliver({ type: "reply.started", reply_id: "r1" });
    sock.deliverRaw("{not json");
    expect(messages).toEqual(['{"type":"reply.started","reply_id":"r1"}', "{not json"]);
  });

  test("our close is dispatched on a microtask with its code; a drop at once; each only once", async () => {
    const sock = connect(createFakeS2sLink());
    const codes: (number | undefined)[] = [];
    sock.addEventListener("close", (event) => codes.push(event.code));
    sock.open();
    sock.close(1000);
    expect(sock.closedByCode).toBe(true);
    expect(codes).toEqual([]);
    await flush();
    expect(codes).toEqual([1000]);
    sock.drop(1006);
    expect(codes).toEqual([1000]);
    expect(sock.dead).toBe(true);

    const dropped = connect(createFakeS2sLink());
    const dropCodes: (number | undefined)[] = [];
    dropped.addEventListener("close", (event) => dropCodes.push(event.code));
    dropped.drop(4001, "auth");
    expect(dropCodes).toEqual([4001]);
    dropped.open();
    expect(dropped.readyState).toBe(3);
  });

  test("an error event carries its message, and a dead socket raises none", () => {
    const sock = connect(createFakeS2sLink());
    const errors: (string | undefined)[] = [];
    sock.addEventListener("error", (event) => errors.push(event.message));
    sock.socketError("ECONNRESET");
    sock.drop(1006);
    sock.socketError("after death");
    expect(errors).toEqual(["ECONNRESET"]);
  });
});

describe("the link's ledgers", () => {
  test("a tool.result answers the call it names, and a session.resume is recorded", () => {
    const link = createFakeS2sLink();
    const sock = connect(link);
    sock.open();
    link.noteCall("c1", sock.id, "r1");
    sock.send(JSON.stringify({ type: "tool.result", call_id: "c1", result: "{}" }));
    sock.send(JSON.stringify({ type: "tool.result", call_id: "unknown", result: "{}" }));
    sock.send(JSON.stringify({ type: "session.resume", session_id: "s-1" }));
    expect(link.calls.get("c1")?.answers).toBe(1);
    expect(link.resumeRequests).toEqual(["s-1"]);
    expect(sock.resumeRequested).toBe("s-1");
  });

  test("a reply's FIRST ending sticks, and a resume marks the calls it carried", () => {
    const link = createFakeS2sLink();
    link.noteCall("c1", 0, "r1");
    link.endReply("interrupted", ["c1", "missing"]);
    link.endReply("completed", ["c1"]);
    link.markSurvivedResume(["c1", "missing"]);
    expect(link.calls.get("c1")).toMatchObject({ replyEnded: "interrupted", survivedResume: true });
  });

  test("socket ids are creation order, and current() is the latest", () => {
    const link = createFakeS2sLink();
    const first = connect(link);
    const second = connect(link);
    expect([first.id, second.id]).toEqual([0, 1]);
    expect(link.current()).toBe(second);
  });
});

test("the transient and fatal close codes are disjoint", () => {
  const fatal: readonly number[] = FATAL_CODES;
  expect(TRANSIENT_CODES.filter((code) => fatal.includes(code))).toEqual([]);
});
