// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { InboxClientFrameSchema, InboxServerFrameSchema } from "./protocol-inbox.ts";

describe("InboxServerFrameSchema", () => {
  test("accepts each server frame the inbox sends", () => {
    for (const frame of [
      { type: "notice", id: "n1", event: "reminder", bytes: 0 },
      { type: "notice", id: "n2", event: "reminder", data: { at: 1 }, bytes: 4096 },
      { type: "session_event", sessionId: "s1", event: { type: "reply.completed", text: "hi" } },
      { type: "session_ended", sessionId: "s1" },
    ]) {
      expect(InboxServerFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
    }
  });

  test("keeps a session event's own fields, checking only its type", () => {
    const parsed = InboxServerFrameSchema.parse({
      type: "session_event",
      sessionId: "s1",
      event: { type: "future.kind", extra: 1 },
    });
    expect(parsed).toEqual({
      type: "session_event",
      sessionId: "s1",
      event: { type: "future.kind", extra: 1 },
    });
  });

  test("refuses a notice with no id or a bad byte count", () => {
    for (const frame of [
      { type: "notice", id: "", event: "e", bytes: 0 },
      { type: "notice", id: "n", event: "e", bytes: -1 },
      { type: "notice", id: "n", event: "e", bytes: 1.5 },
      { type: "session_event", sessionId: "s1", event: {} },
      { type: "ack", id: "n" },
    ]) {
      expect(InboxServerFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(false);
    }
  });
});

describe("InboxClientFrameSchema", () => {
  test("accepts ack and busy, and nothing else", () => {
    expect(InboxClientFrameSchema.safeParse({ type: "ack", id: "n1" }).success).toBe(true);
    expect(InboxClientFrameSchema.safeParse({ type: "busy", id: "n1" }).success).toBe(true);
    expect(InboxClientFrameSchema.safeParse({ type: "notice", id: "n1" }).success).toBe(false);
    expect(InboxClientFrameSchema.safeParse(null).success).toBe(false);
  });
});
