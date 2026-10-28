// Copyright 2026 the AAI authors. MIT license.
// A write naming an identifier no record has shown is refused once — see arg-grounding.ts.

import type { Message } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { groundingRefusal, UNGROUNDED_ARGUMENT_REASON } from "./arg-grounding.ts";

/** The refusal's own text — the result is a serialized failure, so its quotes arrive escaped. */
function text(refusal: string | undefined): string {
  return refusal === undefined ? "" : (JSON.parse(refusal) as { error: string }).error;
}

const WRITES: ReadonlySet<string> = new Set(["exchange_items", "modify_address"]);

const order: Message = {
  role: "tool",
  toolName: "get_order",
  content: JSON.stringify({
    order_id: "#W1234567",
    items: [{ item_id: "1111111111" }, { item_id: "5555555555" }],
  }),
};
const product: Message = {
  role: "tool",
  toolName: "get_product",
  content: JSON.stringify({
    variants: { "2222222222": { item_id: "2222222222", available: true } },
  }),
};

describe("groundingRefusal", () => {
  test("a write whose identifiers all appear in results runs", () => {
    expect(
      groundingRefusal(
        "exchange_items",
        { order_id: "#W1234567", item_ids: ["1111111111"], new_item_ids: ["2222222222"] },
        [order, product],
        WRITES,
      ),
    ).toBeUndefined();
  });

  test("an identifier no result holds is refused, naming the values the records hold", () => {
    const refusal = groundingRefusal(
      "exchange_items",
      { order_id: "#W1234567", item_ids: ["1111111111"], new_item_ids: ["9999999999"] },
      [order],
      WRITES,
    );
    expect(refusal).toContain(UNGROUNDED_ARGUMENT_REASON);
    expect(text(refusal)).toContain('"new_item_ids" as "9999999999"');
    // `new_item_ids` is filled from the records' `item_id`.
    expect(text(refusal)).toContain('"new_item_id" values like "1111111111", "5555555555"');
    expect(text(refusal)).toContain("send the identical call again and it will run");
  });

  test("a read is never checked", () => {
    expect(
      groundingRefusal("get_product", { product_id: "8888888888" }, [], WRITES),
    ).toBeUndefined();
  });

  test("a non-identifier argument is never checked — a dictated address is new by nature", () => {
    expect(
      groundingRefusal(
        "modify_address",
        { user_id: "#W1234567", zip: "80202", address1: "12 Elm St Apt 4" },
        [order],
        WRITES,
      ),
    ).toBeUndefined();
  });

  test("a value inside a longer token is not evidence", () => {
    const refusal = groundingRefusal("exchange_items", { order_id: "#W123" }, [order], WRITES);
    expect(text(refusal)).toContain('"#W123"');
  });

  test("the digits without their # are not the record's identifier", () => {
    const refusal = groundingRefusal("exchange_items", { order_id: "W1234567" }, [order], WRITES);
    expect(text(refusal)).toContain('"W1234567"');
  });

  test("a FAILED result is not evidence, though it echoes the value", () => {
    const failure: Message = { role: "tool", content: "Error: item 9999999999 not found" };
    expect(
      groundingRefusal("exchange_items", { new_item_ids: ["9999999999"] }, [failure], WRITES),
    ).toBeDefined();
  });

  test("refused ONCE: the identical call after the refusal runs", () => {
    const args = { new_item_ids: ["9999999999"] };
    const refusal = groundingRefusal("exchange_items", args, [order], WRITES);
    expect(refusal).toBeDefined();
    const history: Message[] = [
      order,
      { role: "tool", toolName: "exchange_items", content: refusal ?? "" },
    ];
    expect(groundingRefusal("exchange_items", args, history, WRITES)).toBeUndefined();
  });

  test("nested identifiers are checked under their own key", () => {
    const refusal = groundingRefusal(
      "exchange_items",
      { flights: [{ flight_number: "HAT999", date: "2024-05-16" }] },
      [order],
      WRITES,
    );
    expect(text(refusal)).toContain('"flight_number" as "HAT999"');
  });
});
