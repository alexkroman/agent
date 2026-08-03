import { describe, expect, test } from "vitest";
import { normalizeItemId, normalizeOrderId, resolveOrder, resolveVariantId } from "./resolve.ts";
import { createDefaultState, findProduct, isError } from "./store.ts";

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
      expect(normalizeOrderId(spoken), spoken).toBe("#W5866402");
    }
  });
});

describe("normalizeItemId", () => {
  test("strips spoken separators from a digit run", () => {
    expect(normalizeItemId("3909406921")).toBe("3909406921");
    expect(normalizeItemId("390 940 6921")).toBe("3909406921");
    expect(normalizeItemId("3909-406-921")).toBe("3909406921");
  });
});

describe("resolveOrder — canonical ids", () => {
  test("resolves the caller's own order in any spoken form", () => {
    const state = stateFor("olivia_ito_3591");
    for (const spoken of ["#W5866402", "W 5866402", "5866402"]) {
      const order = resolveOrder(state, spoken);
      expect(isError(order) ? null : order.order_id, spoken).toBe("#W5866402");
    }
  });

  test("refuses another customer's order id", () => {
    const state = stateFor("olivia_ito_3591");
    expect(isError(resolveOrder(state, "#W4316152"))).toBe(true);
  });
});

describe("resolveOrder — shorthand", () => {
  test("a single delivered order resolves from a status word", () => {
    const state = stateFor("olivia_ito_3591");
    for (const spoken of ["the delivered one", "my delivered order", "delivered"]) {
      const order = resolveOrder(state, spoken);
      expect(isError(order) ? null : order.order_id, spoken).toBe("#W5866402");
    }
  });

  test("three pending orders make bare 'my pending order' ambiguous, and it lists them", () => {
    const state = stateFor("olivia_ito_3591");
    const result = resolveOrder(state, "my pending order");
    if (!isError(result)) throw new Error("expected ambiguity");
    for (const id of ["#W5442520", "#W7941031", "#W3657213"]) {
      expect(result.error).toContain(id);
    }
  });

  test("an ordinal picks one out of several pending orders", () => {
    const state = stateFor("olivia_ito_3591");
    const first = resolveOrder(state, "my first pending order");
    const second = resolveOrder(state, "the second pending order");
    expect(isError(first) ? null : first.order_id).toBe("#W5442520");
    expect(isError(second) ? null : second.order_id).toBe("#W7941031");
  });

  test("'last' picks the final one", () => {
    const state = stateFor("olivia_ito_3591");
    const result = resolveOrder(state, "my last pending order");
    expect(isError(result) ? null : result.order_id).toBe("#W3657213");
  });

  test("a bare ordinal with no status word indexes all of the caller's orders", () => {
    const state = stateFor("emma_smith_8564");
    const result = resolveOrder(state, "the first one");
    expect(isError(result) ? null : result.order_id).toBe("#W2417020");
  });

  test("a status the caller has none of says what they do have", () => {
    const state = stateFor("harper_brown_7363");
    const result = resolveOrder(state, "my cancelled order");
    if (!isError(result)) throw new Error("expected refusal");
    expect(result.error).toContain("delivered");
    expect(result.error).toContain("pending");
  });

  test("an out-of-range ordinal is refused, not clamped", () => {
    const state = stateFor("emma_smith_8564");
    expect(isError(resolveOrder(state, "the fourth pending order"))).toBe(true);
  });

  test("unresolvable input is refused before authentication too", () => {
    const state = createDefaultState();
    expect(isError(resolveOrder(state, "my pending order"))).toBe(true);
  });
});

describe("resolveVariantId", () => {
  const state = createDefaultState();
  function teaKettle() {
    const product = findProduct(state, "9832717871");
    if (isError(product)) throw new Error(product.error);
    return product;
  }

  test("passes a canonical item id through", () => {
    expect(resolveVariantId(teaKettle(), "3909406921")).toBe("3909406921");
    expect(resolveVariantId(teaKettle(), "390 940 6921")).toBe("3909406921");
  });

  test("refuses an item id belonging to a different product", () => {
    expect(isError(resolveVariantId(teaKettle(), "4725166838"))).toBe(true);
  });

  test("matches a spoken option phrase", () => {
    // 3738831434 is the only stainless steel 1.5 liter kettle. The seed's
    // capacity value is the digit form "1.5 liters" — the matcher is a plain
    // substring test, so the spoken text has to contain it verbatim, not the
    // spelled-out "one point five liters" an STT transcript never produces
    // for a written spec like this either.
    const result = resolveVariantId(teaKettle(), "the stainless steel 1.5 liters");
    expect(result).toBe("3738831434");
  });

  test("an ambiguous phrase lists the candidates with their options", () => {
    const result = resolveVariantId(teaKettle(), "glass");
    if (!isError(result)) throw new Error("expected ambiguity");
    expect(result.error).toContain("glass");
    expect(result.error.match(/\d{10}/g)?.length).toBeGreaterThan(1);
  });

  test("a phrase matching nothing is refused", () => {
    expect(isError(resolveVariantId(teaKettle(), "titanium"))).toBe(true);
  });

  test("availableOnly excludes unavailable variants from matching", () => {
    // 6454334990 is glass / 1.5 liters / induction and unavailable. "glass"
    // is required in the phrase too — capacity + stovetop alone also match
    // the available stainless-steel 1.5L induction variant (3738831434) at
    // the same score, which would make the "loose" match ambiguous instead
    // of the unique glass one this test needs.
    const loose = resolveVariantId(teaKettle(), "glass 1.5 liters induction");
    expect(loose).toBe("6454334990");
    const strict = resolveVariantId(teaKettle(), "glass 1.5 liters induction", {
      availableOnly: true,
    });
    expect(strict).not.toBe("6454334990");
  });
});
