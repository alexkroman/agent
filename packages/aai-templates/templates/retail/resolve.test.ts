import { isToolFailure } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { normalizeOrderId, resolveOrder } from "./resolve.ts";
import { createDefaultState } from "./store.ts";

function stateFor(userId: string) {
  const state = createDefaultState();
  state.authenticatedUserId = userId;
  return state;
}

describe("normalizeOrderId", () => {
  test("accepts every form STT plausibly produces", () => {
    for (const spoken of [
      "#W5866402",
      "W5866402",
      "w5866402",
      "W 5866402",
      "w-5866402",
      "5866402",
      " #w 586 6402 ",
    ]) {
      // Soft: a narrowed normalizer drops a whole family of spoken forms, and
      // which ones it drops is what says where the pattern went wrong.
      expect.soft(normalizeOrderId(spoken), spoken).toBe("#W5866402");
    }
  });
});

describe("resolveOrder — canonical ids", () => {
  test("resolves the caller's own order in any spoken form", () => {
    const state = stateFor("olivia_ito_3591");
    for (const spoken of ["#W5866402", "W 5866402", "5866402"]) {
      const order = resolveOrder(state, spoken);
      expect.soft(isToolFailure(order) ? null : order.order_id, spoken).toBe("#W5866402");
    }
  });

  test("refuses another customer's order id", () => {
    const state = stateFor("olivia_ito_3591");
    expect(isToolFailure(resolveOrder(state, "#W4316152"))).toBe(true);
  });
});

describe("resolveOrder — shorthand", () => {
  test("a single delivered order resolves from a status word", () => {
    const state = stateFor("olivia_ito_3591");
    for (const spoken of ["the delivered one", "my delivered order", "delivered"]) {
      const order = resolveOrder(state, spoken);
      expect.soft(isToolFailure(order) ? null : order.order_id, spoken).toBe("#W5866402");
    }
  });

  test("three pending orders make bare 'my pending order' ambiguous, and it lists them", () => {
    const state = stateFor("olivia_ito_3591");
    const result = resolveOrder(state, "my pending order");
    if (!isToolFailure(result)) throw new Error("expected ambiguity");
    for (const id of ["#W5442520", "#W7941031", "#W3657213"]) {
      expect.soft(result.error, `ambiguity message omits ${id}`).toContain(id);
    }
  });

  test("an ordinal picks one out of several pending orders", () => {
    const state = stateFor("olivia_ito_3591");
    const first = resolveOrder(state, "my first pending order");
    const second = resolveOrder(state, "the second pending order");
    expect(isToolFailure(first) ? null : first.order_id).toBe("#W5442520");
    expect(isToolFailure(second) ? null : second.order_id).toBe("#W7941031");
  });

  test("'last' picks the final one", () => {
    const state = stateFor("olivia_ito_3591");
    const result = resolveOrder(state, "my last pending order");
    expect(isToolFailure(result) ? null : result.order_id).toBe("#W3657213");
  });

  test("a bare ordinal with no status word indexes all of the caller's orders", () => {
    const state = stateFor("emma_smith_8564");
    const result = resolveOrder(state, "the first one");
    expect(isToolFailure(result) ? null : result.order_id).toBe("#W2417020");
  });

  test("a status the caller has none of says what they do have", () => {
    const state = stateFor("harper_brown_7363");
    const result = resolveOrder(state, "my cancelled order");
    if (!isToolFailure(result)) throw new Error("expected refusal");
    expect(result.error).toContain("delivered");
    expect(result.error).toContain("pending");
  });

  test("an out-of-range ordinal is refused, not clamped", () => {
    const state = stateFor("emma_smith_8564");
    expect(isToolFailure(resolveOrder(state, "the fourth pending order"))).toBe(true);
  });

  test("unresolvable input is refused before authentication too", () => {
    const state = createDefaultState();
    expect(isToolFailure(resolveOrder(state, "my pending order"))).toBe(true);
  });
});
