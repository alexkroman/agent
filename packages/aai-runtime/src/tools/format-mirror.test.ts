// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { FORMAT_MISMATCH_REASON, FormatMirror } from "./format-mirror.ts";

/** A fresh mirror per call — the history alone, as a per-turn view reads it. */
const formatMismatchRefusal = (
  name: string,
  args: Record<string, unknown>,
  history: { role: string; content?: unknown }[],
) => new FormatMirror().refuse(name, args, history);

const tool = (record: unknown) => ({ role: "tool", content: JSON.stringify(record) });
const user = {
  user_id: "ethan_garcia_1261",
  address: { address1: "667 Highland Drive", city: "Denver", state: "CO", zip: "80280" },
};

describe("FormatMirror.refuse", () => {
  // tau2 retail task 22: the agent said "New York, New York" aloud and wrote it.
  test("a spoken state name is refused where the records write two capitals", () => {
    const refusal = formatMismatchRefusal(
      "modify_user_address",
      { city: "New York", state: "New York", zip: "10001" },
      [tool(user)],
    );
    const { error, reason } = JSON.parse(refusal ?? "{}") as { error?: string; reason?: string };
    expect(error).toContain('"state" as "New York"');
    expect(error).toContain('like "CO" (2 capital letters)');
    expect(reason).toBe(FORMAT_MISMATCH_REASON);
  });

  test("the records' own form passes", () => {
    const args = { city: "New York", state: "NY", zip: "10001" };
    expect(formatMismatchRefusal("modify_user_address", args, [tool(user)])).toBeUndefined();
  });

  test("a field with no record yet is left alone", () => {
    expect(formatMismatchRefusal("modify_user_address", { state: "New York" }, [])).toBeUndefined();
  });

  // One free-text value anywhere means the field has no single form to mirror.
  test("a field the records write in more than one shape is left alone", () => {
    const history = [tool(user), tool({ address: { state: "Colorado" } })];
    expect(
      formatMismatchRefusal("modify_user_address", { state: "New York" }, history),
    ).toBeUndefined();
  });

  test("free-text fields are never checked", () => {
    const args = { address1: "101 Highway", city: "Springfield" };
    expect(formatMismatchRefusal("modify_user_address", args, [tool(user)])).toBeUndefined();
  });

  // A truncated identifier, from the same runs: `get_item_details({ item_id: "984" })`.
  test("a fixed-length id sent short is refused", () => {
    const history = [tool({ items: [{ item_id: "9844888101" }, { item_id: "1234567890" }] })];
    expect(formatMismatchRefusal("get_item_details", { item_id: "984" }, history)).toContain(
      "10 digits",
    );
  });

  test("the identical value re-sent after the refusal runs", () => {
    const args = { state: "New York" };
    const refusal = formatMismatchRefusal("modify_user_address", args, [tool(user)]);
    const history = [tool(user), { role: "tool", content: refusal }];
    expect(formatMismatchRefusal("modify_user_address", args, history)).toBeUndefined();
  });

  test("non-JSON tool results and other roles are ignored", () => {
    const history = [
      { role: "tool", content: "Error: User not found" },
      { role: "user", content: '{"state":"CO"}' },
    ];
    expect(
      formatMismatchRefusal("modify_user_address", { state: "New York" }, history),
    ).toBeUndefined();
  });

  // Field names match across every tool, so one short code must not police
  // an unrelated tool's free-text argument.
  test("a value of another kind is not refused, even where the field qualifies", () => {
    const history = [tool({ status: "OK", amount: "100", order_id: "#W1234567" })];
    expect(formatMismatchRefusal("set_status", { status: "delivered" }, history)).toBeUndefined();
    expect(formatMismatchRefusal("refund", { amount: "99.50" }, history)).toBeUndefined();
    expect(formatMismatchRefusal("lookup", { order_id: "W1234567" }, history)).toBeDefined();
  });

  test("a full country name is refused where the records write three capitals", () => {
    const history = [tool({ address: { country: "USA" } })];
    expect(
      formatMismatchRefusal("modify_user_address", { country: "United States" }, history),
    ).toContain("3 capital letters");
  });
});

describe("FormatMirror, held by a session", () => {
  test("a sibling call with the same mismatch is refused once, not twice", () => {
    const mirror = new FormatMirror();
    const history = [tool(user)];
    const args = { state: "New York" };
    expect(mirror.refuse("modify_user_address", args, history)).toBeDefined();
    // Same snapshot: the sibling never saw the first refusal in its history.
    expect(mirror.refuse("modify_user_address", args, history)).toBeUndefined();
  });

  test("a record too large for the history's capped copy is still observed", () => {
    const mirror = new FormatMirror();
    const whole = JSON.stringify({ ...user, orders: "x".repeat(20_000) });
    // The history holds a truncated, unparseable copy.
    const recorded = { role: "tool", content: whole.slice(0, 16_000) };
    mirror.observeResult(whole, recorded);
    const history = [recorded];
    expect(mirror.refuse("modify_user_address", { state: "New York" }, history)).toBeDefined();
  });

  test("a history sharing no message with the last is a new conversation", () => {
    const mirror = new FormatMirror();
    expect(mirror.refuse("x", { state: "New York" }, [tool(user)])).toBeDefined();
    // A reset: nothing observed before carries over, so nothing qualifies.
    expect(mirror.refuse("x", { state: "Texas" }, [tool({ note: "hi" })])).toBeUndefined();
  });

  // Retention trims a long session from the front. That is the same
  // conversation: its records and refusals still count.
  test("a history trimmed from the front keeps what was observed", () => {
    const mirror = new FormatMirror();
    const record = tool(user);
    const later = tool({ note: "hi" });
    expect(mirror.refuse("x", { state: "New York" }, [record, later])).toBeDefined();
    const trimmed = [later];
    expect(mirror.refuse("x", { state: "New York" }, trimmed)).toBeUndefined();
    expect(mirror.refuse("x", { state: "Texas" }, trimmed)).toBeDefined();
  });
});
