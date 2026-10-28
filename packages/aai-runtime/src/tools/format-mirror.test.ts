// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { FORMAT_MISMATCH_REASON, FormatMirror } from "./format-mirror.ts";

/** A fresh mirror that has read `history`, asked about one call. */
function formatMismatchRefusal(
  name: string,
  args: Record<string, unknown>,
  history: { role: string; content?: unknown }[],
): string | undefined {
  const mirror = new FormatMirror();
  mirror.read(history);
  return mirror.refuse(name, args);
}

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

describe("FormatMirror, beyond the history", () => {
  test("a record too large for the history's capped copy is observed from the result", () => {
    const mirror = new FormatMirror();
    mirror.read([{ role: "tool", content: JSON.stringify(user).slice(0, 40) }]);
    expect(mirror.refuse("x", { state: "New York" })).toBeUndefined();
    mirror.observeResult(JSON.stringify(user));
    expect(mirror.refuse("x", { state: "New York" })).toBeDefined();
  });

  test("a reset forgets the records and the refusals", () => {
    const mirror = new FormatMirror();
    mirror.read([tool(user)]);
    expect(mirror.refuse("x", { state: "New York" })).toBeDefined();
    mirror.reset();
    expect(mirror.refuse("x", { state: "Texas" })).toBeUndefined();
  });
});
