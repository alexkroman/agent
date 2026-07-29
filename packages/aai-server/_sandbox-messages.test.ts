// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the host-side message delta tracker: the "may I append?"
 * identity check, splice/reset fallback to full sends, per-session
 * independence, and the desync response detector.
 */

import type { Message } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { createMessageDeltaTracker, isMessagesDesync } from "./_sandbox-messages.ts";
import { MESSAGES_DESYNC_ERROR } from "./guest/harness-messages.ts";

function msg(content: string, role: Message["role"] = "user"): Message {
  return { role, content };
}

describe("createMessageDeltaTracker", () => {
  test("first call for a session sends full history", () => {
    const tracker = createMessageDeltaTracker();
    const history = [msg("a"), msg("b")];

    const delta = tracker.delta("s1", history);

    expect(delta).toEqual({ messages: history, messagesMode: "full" });
  });

  test("appends only the tail when the sent prefix is identity-stable", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    const b = msg("b", "assistant");
    const c = msg("c");
    tracker.delta("s1", [a, b]);

    // The runtime snapshots with history.slice(): fresh array, same elements.
    const delta = tracker.delta("s1", [a, b, c]);

    expect(delta).toEqual({ messages: [c], messagesMode: "append", messagesBase: 2 });
  });

  test("unchanged history appends an empty tail", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    tracker.delta("s1", [a]);

    const delta = tracker.delta("s1", [a]);

    expect(delta).toEqual({ messages: [], messagesMode: "append", messagesBase: 1 });
  });

  test("appends everything after a session started empty", () => {
    const tracker = createMessageDeltaTracker();
    tracker.delta("s1", []);

    const a = msg("a");
    const delta = tracker.delta("s1", [a]);

    expect(delta).toEqual({ messages: [a], messagesMode: "append", messagesBase: 0 });
  });

  test("front splice (maxHistory cap) breaks identity and falls back to full", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    const b = msg("b");
    const c = msg("c");
    tracker.delta("s1", [a, b]);

    // The cap spliced `a` off the front — messages[0] is a different object.
    const delta = tracker.delta("s1", [b, c]);

    expect(delta.messagesMode).toBe("full");
    expect(delta.messages).toEqual([b, c]);
  });

  test("equal-content but different objects at the watermark forces full", () => {
    const tracker = createMessageDeltaTracker();
    tracker.delta("s1", [msg("a")]);

    // A reset rebuilt the history: structurally equal, different identity.
    const delta = tracker.delta("s1", [msg("a"), msg("b")]);

    expect(delta.messagesMode).toBe("full");
  });

  test("shrunken history (client reset) falls back to full", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    const b = msg("b");
    tracker.delta("s1", [a, b]);

    const delta = tracker.delta("s1", [a]);

    expect(delta.messagesMode).toBe("full");
    expect(delta.messages).toEqual([a]);
  });

  test("sessions are tracked independently", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    tracker.delta("s1", [a]);

    const other = tracker.delta("s2", [a]);
    expect(other.messagesMode).toBe("full");

    const delta = tracker.delta("s1", [a, msg("b")]);
    expect(delta.messagesMode).toBe("append");
  });

  test("reset forces the next call to send full history", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    tracker.delta("s1", [a]);
    tracker.reset("s1");

    const delta = tracker.delta("s1", [a, msg("b")]);

    expect(delta.messagesMode).toBe("full");
  });

  test("full sends copy the snapshot so callers cannot alias the params array", () => {
    const tracker = createMessageDeltaTracker();
    const history = [msg("a")];

    const delta = tracker.delta("s1", history);

    expect(delta.messages).not.toBe(history);
    expect(delta.messages).toEqual(history);
  });
});

describe("isMessagesDesync", () => {
  test("matches the guest's desync error response", () => {
    expect(isMessagesDesync({ error: MESSAGES_DESYNC_ERROR })).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isMessagesDesync({ error: "boom" })).toBe(false);
    expect(isMessagesDesync({ result: MESSAGES_DESYNC_ERROR })).toBe(false);
    expect(isMessagesDesync(undefined)).toBe(false);
    expect(isMessagesDesync(null)).toBe(false);
    expect(isMessagesDesync(MESSAGES_DESYNC_ERROR)).toBe(false);
  });
});
