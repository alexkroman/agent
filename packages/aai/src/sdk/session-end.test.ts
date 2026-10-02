// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createToolContext, endSessionCalls } from "./_testing-context.ts";
import { claimSessionEnder, endSession } from "./session-end.ts";

describe("endSession", () => {
  test("calls the session's ender, afterReply defaulting to true", () => {
    const ender = vi.fn();
    claimSessionEnder("end-a", ender);
    expect(endSession({ sessionId: "end-a" })).toBe(true);
    expect(endSession({ sessionId: "end-a" }, { afterReply: false })).toBe(true);
    expect(ender.mock.calls).toEqual([[{ afterReply: true }], [{ afterReply: false }]]);
  });

  test("answers false for a session nothing registered — already ended, or never connected", () => {
    expect(endSession({ sessionId: "end-nobody" })).toBe(false);
  });

  test("a superseded claim's release leaves the resumed connection's ender in place", () => {
    // The resume hazard: the old connection's teardown settles AFTER a reconnect
    // with the same id registered its own ender. A keyed delete would leave the
    // live session with no way to end it.
    const asked: string[] = [];
    const releaseOld = claimSessionEnder("end-b", () => asked.push("old"));
    const releaseNew = claimSessionEnder("end-b", () => asked.push("new"));
    expect(releaseOld()).toBe(false);
    endSession({ sessionId: "end-b" });
    expect(asked).toEqual(["new"]);
    expect(releaseNew()).toBe(true);
    expect(endSession({ sessionId: "end-b" })).toBe(false);
  });

  test("createToolContext records what a tool asked for, read with endSessionCalls", () => {
    const ctx = createToolContext();
    expect(endSessionCalls(ctx)).toEqual([]);
    expect(endSession(ctx)).toBe(true);
    expect(endSessionCalls(ctx)).toEqual([{ afterReply: true }]);
    // Two contexts are two sessions: the other one heard nothing.
    expect(endSessionCalls(createToolContext())).toEqual([]);
    // A reused id starts a fresh record rather than inheriting this one.
    expect(endSessionCalls(createToolContext({ sessionId: ctx.sessionId }))).toEqual([]);
  });
});
