// Copyright 2026 the AAI authors. MIT license.
/**
 * The receiving rules of `WS /inbox`, frame by frame. They are the cases the
 * speaker's firmware (`inbox.c`) handles, because a page holding the same
 * client's inbox must answer the agent exactly as the device would — the
 * server settles one notice across every holder, so one holder answering
 * differently changes what all of them are offered.
 */

import { describe, expect, test } from "vitest";
import {
  createNoticeAssembler,
  MAX_NOTICE_BYTES,
  parseInboxEvent,
  parseNoticeHeader,
  RECENT_NOTICE_IDS,
} from "./inbox-protocol.ts";

const header = (id: string, bytes: number, extra: object = {}) =>
  JSON.stringify({ type: "notice", id, event: "reminder", bytes, ...extra });

describe("parseNoticeHeader", () => {
  test("refuses what the device refuses", () => {
    expect(parseNoticeHeader("not json")).toBeUndefined();
    expect(
      parseNoticeHeader(JSON.stringify({ type: "other", id: "a", event: "e", bytes: 0 })),
    ).toBeUndefined();
    expect(parseNoticeHeader(header("", 0))).toBeUndefined();
    expect(parseNoticeHeader(header("a", 3))).toBeUndefined(); // odd: not PCM16
    expect(parseNoticeHeader(header("a", -2))).toBeUndefined();
    expect(parseNoticeHeader(header("a", MAX_NOTICE_BYTES + 2))).toBeUndefined();
  });

  test("keeps an object `data` and drops any other", () => {
    expect(parseNoticeHeader(header("a", 4, { data: { text: "x" } }))).toEqual({
      id: "a",
      event: "reminder",
      bytes: 4,
      data: { text: "x" },
    });
    expect(parseNoticeHeader(header("a", 4, { data: "x" }))).toEqual({
      id: "a",
      event: "reminder",
      bytes: 4,
    });
  });
});

describe("parseInboxEvent", () => {
  test("reads the two live frames and nothing else", () => {
    const event = { type: "userTranscript.committed", text: "hi" };
    expect(
      parseInboxEvent(JSON.stringify({ type: "session_event", sessionId: "s1", event })),
    ).toEqual({ type: "session_event", sessionId: "s1", event });
    expect(parseInboxEvent(JSON.stringify({ type: "session_ended", sessionId: "s1" }))).toEqual({
      type: "session_ended",
      sessionId: "s1",
    });
    expect(parseInboxEvent(header("r1", 0))).toBeUndefined();
    expect(
      parseInboxEvent(JSON.stringify({ type: "session_event", sessionId: "s1" })),
    ).toBeUndefined();
    expect(parseInboxEvent("{")).toBeUndefined();
  });
});

describe("createNoticeAssembler", () => {
  test("assembles audio across frames and acks at the end", () => {
    const a = createNoticeAssembler(() => false);
    expect(a.text(header("r1", 4, { data: { text: "call the plumber" } }))).toBeUndefined();
    expect(a.bytes(new Uint8Array([1, 2]))).toBeUndefined();
    const out = a.bytes(new Uint8Array([3, 4, 9, 9])); // past `bytes` is dropped
    expect(out?.reply).toEqual({ type: "ack", id: "r1" });
    expect([...(out?.notice?.pcm ?? [])]).toEqual([1, 2, 3, 4]);
    expect(out?.notice?.data).toEqual({ text: "call the plumber" });
  });

  test("a notice with no audio is delivered at once", () => {
    const out = createNoticeAssembler(() => false).text(header("r1", 0));
    expect(out).toEqual({
      notice: { id: "r1", event: "reminder", pcm: new Uint8Array(0) },
      reply: { type: "ack", id: "r1" },
    });
  });

  test("mid-conversation it answers busy and drops the audio", () => {
    const a = createNoticeAssembler(() => true);
    expect(a.text(header("r1", 2))).toEqual({ reply: { type: "busy", id: "r1" } });
    expect(a.bytes(new Uint8Array([1, 2]))).toBeUndefined();
  });

  test("a redelivery after a lost ack is acked, not played again", () => {
    const a = createNoticeAssembler(() => false);
    a.text(header("r1", 2));
    expect(a.bytes(new Uint8Array([1, 2]))?.notice).toBeDefined();
    a.text(header("r1", 2));
    expect(a.bytes(new Uint8Array([1, 2]))).toEqual({ reply: { type: "ack", id: "r1" } });
  });

  test("a repeat is acked even while busy, so it stops being resent", () => {
    let busy = false;
    const a = createNoticeAssembler(() => busy);
    a.text(header("r1", 0));
    busy = true;
    expect(a.text(header("r1", 0))).toEqual({ reply: { type: "ack", id: "r1" } });
  });

  test("a header mid-notice cuts the last one short, unacked", () => {
    const a = createNoticeAssembler(() => false);
    a.text(header("r1", 4));
    a.bytes(new Uint8Array([1, 2]));
    expect(a.text(header("r2", 2))).toBeUndefined();
    expect(a.bytes(new Uint8Array([5, 6]))?.reply).toEqual({ type: "ack", id: "r2" });
    // r1 was never acked, so its resend plays.
    a.text(header("r1", 2));
    expect(a.bytes(new Uint8Array([1, 2]))?.notice?.id).toBe("r1");
  });

  test("reset() drops the half-received notice and keeps the repeat memory", () => {
    const a = createNoticeAssembler(() => false);
    a.text(header("r1", 0));
    a.text(header("r2", 4));
    a.bytes(new Uint8Array([1, 2]));
    a.reset();
    expect(a.bytes(new Uint8Array([3, 4]))).toBeUndefined();
    expect(a.text(header("r1", 0))).toEqual({ reply: { type: "ack", id: "r1" } });
  });

  test(`remembers the last ${RECENT_NOTICE_IDS} ids, then forgets the oldest`, () => {
    const a = createNoticeAssembler(() => false);
    for (let i = 0; i <= RECENT_NOTICE_IDS; i++) a.text(header(`r${i}`, 0));
    expect(a.text(header("r0", 0))?.notice?.id).toBe("r0");
    expect(a.text(header(`r${RECENT_NOTICE_IDS}`, 0))?.notice).toBeUndefined();
  });

  test("bytes with no header are dropped", () => {
    expect(createNoticeAssembler(() => false).bytes(new Uint8Array([1, 2]))).toBeUndefined();
  });
});
