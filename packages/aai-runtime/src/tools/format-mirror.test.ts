// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { FORMAT_MISMATCH_REASON, formatMismatchRefusal } from "./format-mirror.ts";

const tool = (record: unknown) => ({ role: "tool", content: JSON.stringify(record) });
const user = {
  user_id: "ethan_garcia_1261",
  address: { address1: "667 Highland Drive", city: "Denver", state: "CO", zip: "80280" },
};

describe("formatMismatchRefusal", () => {
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
});
