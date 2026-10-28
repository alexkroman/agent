// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { ToolCallGuards } from "./call-guards.ts";

const tool = (record: unknown) => ({ role: "tool", content: JSON.stringify(record) });
const user = { address: { city: "Denver", state: "CO" } };
const NOT_FOUND = "Error: User not found";

describe("ToolCallGuards", () => {
  test("a sibling call with the same format mismatch is refused once, not twice", () => {
    const guards = new ToolCallGuards({ rememberFailures: false });
    const history = [tool(user)];
    expect(guards.refuse("modify_user_address", { state: "New York" }, history)).toBeDefined();
    // Same snapshot: the sibling never saw the first refusal in its history.
    expect(guards.refuse("modify_user_address", { state: "New York" }, history)).toBeUndefined();
  });

  test("a settled result is read WHOLE, and its capped copy is not read again", () => {
    const guards = new ToolCallGuards({ rememberFailures: false });
    const whole = JSON.stringify({ ...user, orders: "x".repeat(20_000) });
    // The history's copy is truncated, and no longer JSON.
    const recorded = { role: "tool", content: whole.slice(0, 16_000) };
    guards.settle("get_user", {}, whole, recorded);
    expect(guards.refuse("x", { state: "New York" }, [recorded])).toBeDefined();
  });

  test("an identical failed call is refused only where failures are remembered", () => {
    const session = new ToolCallGuards({ rememberFailures: true });
    const turn = new ToolCallGuards({ rememberFailures: false });
    const args = { first: "Sophia" };
    expect(session.settle("find_user", args, NOT_FOUND, {})).toContain("Already tried");
    expect(turn.settle("find_user", args, NOT_FOUND, {})).toBeUndefined();
    expect(session.refuse("find_user", args, [])).toBeDefined();
    expect(turn.refuse("find_user", args, [])).toBeUndefined();
  });

  test("a history sharing no message with the last is a new conversation for every guard", () => {
    const guards = new ToolCallGuards({ rememberFailures: true });
    guards.settle("find_user", { first: "Sophia" }, NOT_FOUND, {});
    expect(guards.refuse("x", { state: "New York" }, [tool(user)])).toBeDefined();
    const reset = [tool({ note: "hi" })];
    expect(guards.refuse("x", { state: "Texas" }, reset)).toBeUndefined();
    expect(guards.refuse("find_user", { first: "Sophia" }, reset)).toBeUndefined();
  });

  // Retention trims a long session from the front. That is the same
  // conversation: its records, refusals and failures still count.
  test("a history trimmed from the front keeps everything", () => {
    const guards = new ToolCallGuards({ rememberFailures: true });
    const record = tool(user);
    const later = tool({ note: "hi" });
    guards.settle("find_user", { first: "Sophia" }, NOT_FOUND, later);
    expect(guards.refuse("x", { state: "New York" }, [record, later])).toBeDefined();
    const trimmed = [later];
    expect(guards.refuse("x", { state: "New York" }, trimmed)).toBeUndefined();
    expect(guards.refuse("x", { state: "Texas" }, trimmed)).toBeDefined();
    expect(guards.refuse("find_user", { first: "Sophia" }, trimmed)).toBeDefined();
  });

  // A subagent's and `TextAgent.tools`' views are always empty.
  test("an empty history is not a reset", () => {
    const guards = new ToolCallGuards({ rememberFailures: false });
    guards.settle("get_user", {}, JSON.stringify(user), {});
    expect(guards.refuse("x", { state: "New York" }, [])).toBeDefined();
  });
});
