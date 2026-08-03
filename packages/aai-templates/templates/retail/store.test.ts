import type { ToolContext } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import {
  authenticatedUser,
  createDefaultState,
  findItem,
  findOrder,
  findPaymentMethod,
  findProduct,
  findUser,
  findVariant,
  getState,
  isError,
  isGiftCard,
  money,
  requireOwnOrder,
} from "./store.ts";

let sessionCounter = 0;

function makeCtx(): ToolContext {
  return {
    sessionId: `test-session-${++sessionCounter}`,
    send: () => {},
    env: {},
    state: {},
    messages: [],
  } as unknown as ToolContext;
}

describe("session state", () => {
  test("getState seeds lazily and returns the same object on re-entry", () => {
    const ctx = makeCtx();
    const a = getState(ctx);
    const b = getState(ctx);
    expect(a).toBe(b);
    expect(a.authenticatedUserId).toBeNull();
    expect(a.callSeq).toBe(0);
    expect(Object.keys(a.store.orders)).toHaveLength(22);
  });

  test("each session gets its own deep copy — a mutation cannot leak across sessions", () => {
    const first = getState(makeCtx());
    const order = first.store.orders["#W9300146"];
    if (!order) throw new Error("fixture missing");
    order.status = "cancelled";
    const giftCard = first.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    if (giftCard?.source === "gift_card") giftCard.balance = 0;

    const second = getState(makeCtx());
    expect(second.store.orders["#W9300146"]?.status).toBe("pending");
    const fresh = second.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(fresh?.source === "gift_card" && fresh.balance).toBe(17);
  });
});

describe("money", () => {
  test("rounds to two decimals", () => {
    expect(money(3.005)).toBe(3.01);
    expect(money(0.1 + 0.2)).toBe(0.3);
    expect(money(-40.860_000_000_000_014)).toBe(-40.86);
  });
});

describe("lookups", () => {
  test("findUser resolves and reports a miss by id", () => {
    const state = createDefaultState();
    expect(isError(findUser(state, "olivia_ito_3591"))).toBe(false);
    const miss = findUser(state, "nobody_1");
    expect(isError(miss) && miss.error).toContain("nobody_1");
  });

  test("findOrder resolves and reports a miss", () => {
    const state = createDefaultState();
    const order = findOrder(state, "#W5866402");
    expect(isError(order)).toBe(false);
    expect(isError(order) ? null : order.status).toBe("delivered");
    expect(isError(findOrder(state, "#W0000000"))).toBe(true);
  });

  test("findProduct and findVariant resolve within one product", () => {
    const state = createDefaultState();
    const product = findProduct(state, "9832717871");
    if (isError(product)) throw new Error(product.error);
    expect(product.name).toBe("Tea Kettle");
    const variant = findVariant(product, "3909406921");
    expect(isError(variant) ? null : variant.price).toBe(98.25);
    // A real item id, but of a different product.
    expect(isError(findVariant(product, "4725166838"))).toBe(true);
  });

  test("findItem scans every product and returns both product and variant", () => {
    const state = createDefaultState();
    const found = findItem(state, "3909406921");
    if (isError(found)) throw new Error(found.error);
    expect(found.product.product_id).toBe("9832717871");
    expect(found.variant.price).toBe(98.25);
    expect(isError(findItem(state, "0000000000"))).toBe(true);
  });

  test("findPaymentMethod resolves on the owning user only", () => {
    const state = createDefaultState();
    const olivia = findUser(state, "olivia_ito_3591");
    if (isError(olivia)) throw new Error(olivia.error);
    expect(isError(findPaymentMethod(olivia, "gift_card_7794233"))).toBe(false);
    // aarav's card is not olivia's.
    expect(isError(findPaymentMethod(olivia, "gift_card_7245904"))).toBe(true);
  });

  test("isGiftCard narrows", () => {
    const state = createDefaultState();
    const olivia = findUser(state, "olivia_ito_3591");
    if (isError(olivia)) throw new Error(olivia.error);
    const card = olivia.payment_methods.gift_card_7794233;
    const paypal = olivia.payment_methods.paypal_8049766;
    expect(card && isGiftCard(card)).toBe(true);
    expect(paypal && isGiftCard(paypal)).toBe(false);
  });
});

describe("ownership and authentication guards", () => {
  test("authenticatedUser errors before authentication", () => {
    const state = createDefaultState();
    const result = authenticatedUser(state);
    expect(isError(result) && result.error.toLowerCase()).toContain("find_user_id_by_email");
  });

  test("requireOwnOrder refuses another customer's order without revealing it", () => {
    const state = createDefaultState();
    state.authenticatedUserId = "olivia_ito_3591";
    const result = requireOwnOrder(state, "#W4316152"); // aarav's
    expect(isError(result)).toBe(true);
    if (!isError(result)) throw new Error("expected refusal");
    expect(result.error).not.toContain("aarav");
    expect(result.error).not.toContain("Tea Kettle");
  });

  test("requireOwnOrder gives the same answer for an unknown order — no existence oracle", () => {
    const state = createDefaultState();
    state.authenticatedUserId = "olivia_ito_3591";
    const foreign = requireOwnOrder(state, "#W4316152");
    const missing = requireOwnOrder(state, "#W0000000");
    expect(isError(foreign) && isError(missing)).toBe(true);
    if (!(isError(foreign) && isError(missing))) throw new Error("expected refusals");
    expect(foreign.error).toBe(missing.error);
  });

  test("requireOwnOrder resolves the caller's own order", () => {
    const state = createDefaultState();
    state.authenticatedUserId = "olivia_ito_3591";
    const result = requireOwnOrder(state, "#W5866402");
    expect(isError(result) ? null : result.order_id).toBe("#W5866402");
  });
});
