// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createToolContext, sentDtmfCalls } from "./_testing-context.ts";
import { claimDtmfSender, MAX_DTMF_KEYS, sendDtmf } from "./session-dtmf.ts";

describe("sendDtmf", () => {
  test("hands the session's sender the keys, separators dropped and A-D raised", () => {
    const sender = vi.fn();
    claimDtmfSender("dtmf-a", sender);
    expect(sendDtmf({ sessionId: "dtmf-a" }, "1")).toBe(true);
    expect(sendDtmf({ sessionId: "dtmf-a" }, "555-0100, #")).toBe(true);
    expect(sendDtmf({ sessionId: "dtmf-a" }, "*a w 9")).toBe(true);
    expect(sender.mock.calls).toEqual([["1"], ["5550100#"], ["*Aw9"]]);
  });

  test("answers false for a session nothing registered — already ended, or never connected", () => {
    expect(sendDtmf({ sessionId: "dtmf-nobody" }, "1")).toBe(false);
  });

  test.each([
    ["", /no keys/],
    [" , ", /no keys/],
    ["1x", /"x" is not a phone key/],
    ["one", /"o" is not a phone key/],
    ["1".repeat(MAX_DTMF_KEYS + 1), /over the 64-key limit/],
  ])("refuses %j before reaching any sender", (keys, message) => {
    const sender = vi.fn();
    claimDtmfSender("dtmf-bad", sender);
    expect(() => sendDtmf({ sessionId: "dtmf-bad" }, keys)).toThrow(message);
    expect(sender).not.toHaveBeenCalled();
  });

  test("a superseded claim's release leaves the resumed connection's sender in place", () => {
    const heard: string[] = [];
    const releaseOld = claimDtmfSender("dtmf-b", () => heard.push("old"));
    const releaseNew = claimDtmfSender("dtmf-b", () => heard.push("new"));
    expect(releaseOld()).toBe(false);
    sendDtmf({ sessionId: "dtmf-b" }, "1");
    expect(heard).toEqual(["new"]);
    expect(releaseNew()).toBe(true);
    expect(sendDtmf({ sessionId: "dtmf-b" }, "1")).toBe(false);
  });

  test("createToolContext records each press for sentDtmfCalls", () => {
    const ctx = createToolContext();
    expect(sentDtmfCalls(ctx)).toEqual([]);
    expect(sendDtmf(ctx, "1")).toBe(true);
    expect(sendDtmf(ctx, "2, #")).toBe(true);
    expect(sentDtmfCalls(ctx)).toEqual(["1", "2#"]);
    // A fresh context on the same id starts its own record.
    expect(sentDtmfCalls(createToolContext({ sessionId: ctx.sessionId }))).toEqual([]);
  });
});
