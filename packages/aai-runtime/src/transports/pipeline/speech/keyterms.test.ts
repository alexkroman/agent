// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createKeytermHarvester, isKeyterm, keytermsIn, MAX_KEYTERMS } from "./keyterms.ts";

// Shaped like a tau2 retail `get_order_details` result.
const ORDER = JSON.stringify({
  order_id: "#W5565470",
  user_id: "isabella_johansson_2152",
  address: { address1: "313 Chestnut Street", city: "Houston", state: "TX", zip: "77001" },
  items: [
    { name: "Pet Bed", item_id: "7381052709", options: { size: "large", material: "polyester" } },
    { name: "Electric Kettle", item_id: "9472539378", options: { color: "black" } },
  ],
  status: "delivered",
  payment_history: [{ payment_method_id: "paypal_3024827", amount: 54.04 }],
});

describe("keyterm shape", () => {
  test("keeps proper nouns and product names", () => {
    for (const t of ["Pet Bed", "Isabella", "Johansson", "Houston", "O'Brien", "Mary-Kate"]) {
      expect(isKeyterm(t), t).toBe(true);
    }
  });

  test("drops ids, codes, snake_case, sentences and lowercase values", () => {
    for (const t of ["#W5565470", "paypal_3024827", "TX", "delivered", "polyester", "a"]) {
      expect(isKeyterm(t), t).toBe(false);
    }
    expect(isKeyterm("Your order has shipped to the address on file")).toBe(false);
  });

  test("harvests the record's names from a tool result, and nothing from non-JSON", () => {
    expect(keytermsIn(ORDER)).toEqual(["Houston", "Pet Bed", "Electric Kettle"]);
    expect(keytermsIn("Error: User not found")).toEqual([]);
  });
});

describe("createKeytermHarvester", () => {
  test("pushes the whole set when it grows, and nothing when it doesn't", () => {
    const update = vi.fn();
    const h = createKeytermHarvester(update);
    h.observe(JSON.stringify({ first_name: "Isabella", last_name: "Johansson" }));
    h.observe(ORDER);
    h.observe(ORDER);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.at(-1)?.[0]).toEqual([
      "Isabella",
      "Johansson",
      "Houston",
      "Pet Bed",
      "Electric Kettle",
    ]);
  });

  test("keeps the most recent MAX_KEYTERMS, dropping the oldest", () => {
    const update = vi.fn();
    const h = createKeytermHarvester(update);
    const names = Array.from(
      { length: MAX_KEYTERMS + 5 },
      (_, i) =>
        `Name${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
    );
    h.observe(JSON.stringify(names));
    const last = update.mock.calls.at(-1)?.[0] as string[];
    expect(last).toHaveLength(MAX_KEYTERMS);
    expect(last[0]).toBe(names[5]);
    expect(last.at(-1)).toBe(names.at(-1));
  });
});
