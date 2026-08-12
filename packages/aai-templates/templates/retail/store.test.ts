import { isToolFailure, type ToolContext } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  authenticatedUser,
  createDefaultState,
  findItem,
  findOrder,
  findPaymentMethod,
  findProduct,
  findUser,
  findVariant,
  isGiftCard,
  money,
  requireOwnOrder,
  retailSlot,
  retailTool,
  type StateSlot,
} from "./store.ts";

function makeCtx(): ToolContext<StateSlot> {
  return createToolContext<StateSlot>();
}

describe("session state", () => {
  test("the slot seeds lazily and returns the same object on re-entry", () => {
    const ctx = makeCtx();
    const a = retailSlot.get(ctx);
    const b = retailSlot.get(ctx);
    expect(a).toBe(b);
    expect(a.authenticatedUserId).toBeNull();
    expect(a.callSeq).toBe(0);
    expect(Object.keys(a.store.orders)).toHaveLength(22);
  });

  test("each session gets its own deep copy — a mutation cannot leak across sessions", () => {
    const first = retailSlot.get(makeCtx());
    const order = first.store.orders["#W9300146"];
    if (!order) throw new Error("fixture missing");
    order.status = "cancelled";
    const giftCard = first.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    if (giftCard?.source === "gift_card") giftCard.balance = 0;

    const second = retailSlot.get(makeCtx());
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
    expect(isToolFailure(findUser(state, "olivia_ito_3591"))).toBe(false);
    const miss = findUser(state, "nobody_1");
    expect(isToolFailure(miss) && miss.error).toContain("nobody_1");
  });

  test("findOrder resolves and reports a miss", () => {
    const state = createDefaultState();
    const order = findOrder(state, "#W5866402");
    expect(isToolFailure(order)).toBe(false);
    expect(isToolFailure(order) ? null : order.status).toBe("delivered");
    expect(isToolFailure(findOrder(state, "#W0000000"))).toBe(true);
  });

  test("findProduct and findVariant resolve within one product", () => {
    const state = createDefaultState();
    const product = findProduct(state, "9832717871");
    if (isToolFailure(product)) throw new Error(product.error);
    expect(product.name).toBe("Tea Kettle");
    const variant = findVariant(product, "3909406921");
    expect(isToolFailure(variant) ? null : variant.price).toBe(98.25);
    // A real item id, but of a different product.
    expect(isToolFailure(findVariant(product, "4725166838"))).toBe(true);
  });

  test("findItem scans every product and returns both product and variant", () => {
    const state = createDefaultState();
    const found = findItem(state, "3909406921");
    if (isToolFailure(found)) throw new Error(found.error);
    expect(found.product.product_id).toBe("9832717871");
    expect(found.variant.price).toBe(98.25);
    expect(isToolFailure(findItem(state, "0000000000"))).toBe(true);
  });

  test("findPaymentMethod resolves on the owning user only", () => {
    const state = createDefaultState();
    const olivia = findUser(state, "olivia_ito_3591");
    if (isToolFailure(olivia)) throw new Error(olivia.error);
    expect(isToolFailure(findPaymentMethod(olivia, "gift_card_7794233"))).toBe(false);
    // aarav's card is not olivia's.
    expect(isToolFailure(findPaymentMethod(olivia, "gift_card_7245904"))).toBe(true);
  });

  test("isGiftCard narrows", () => {
    const state = createDefaultState();
    const olivia = findUser(state, "olivia_ito_3591");
    if (isToolFailure(olivia)) throw new Error(olivia.error);
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
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("find_user_id_by_email");
  });

  test("requireOwnOrder refuses another customer's order without revealing it", () => {
    const state = createDefaultState();
    state.authenticatedUserId = "olivia_ito_3591";
    const result = requireOwnOrder(state, "#W4316152"); // aarav's
    expect(isToolFailure(result)).toBe(true);
    if (!isToolFailure(result)) throw new Error("expected refusal");
    expect(result.error).not.toContain("aarav");
    expect(result.error).not.toContain("Tea Kettle");
  });

  test("requireOwnOrder gives the same shape of answer for an unknown order — no existence oracle", () => {
    const state = createDefaultState();
    state.authenticatedUserId = "olivia_ito_3591";
    const foreignId = "#W4316152";
    const missingId = "#W0000000";
    const foreign = requireOwnOrder(state, foreignId);
    const missing = requireOwnOrder(state, missingId);
    expect(isToolFailure(foreign) && isToolFailure(missing)).toBe(true);
    if (!(isToolFailure(foreign) && isToolFailure(missing))) throw new Error("expected refusals");
    // Structural, not literal, equality: the messages legitimately differ by
    // the id the caller themselves passed in (that's not information about
    // the store — they already knew it), so comparing byte-for-byte would be
    // unsatisfiable by any implementation that echoes the id back for repair
    // retries, as every sibling lookup in this file does. Normalizing the id
    // out asserts the actual guarantee: no wording distinguishes "belongs to
    // someone else" from "doesn't exist".
    const shape = (msg: string, id: string) => msg.replace(id, "<ID>");
    expect(shape(foreign.error, foreignId)).toBe(shape(missing.error, missingId));
  });

  test("requireOwnOrder resolves the caller's own order", () => {
    const state = createDefaultState();
    state.authenticatedUserId = "olivia_ito_3591";
    const result = requireOwnOrder(state, "#W5866402");
    expect(isToolFailure(result) ? null : result.order_id).toBe("#W5866402");
  });
});

describe("retailTool", () => {
  const echo = retailTool({
    name: "echo",
    description: "test tool",
    input: z.object({ value: z.string() }),
    requiresAuth: false,
    summary: (args) => `echoed ${args.value}`,
    run: (args) => ({ echoed: args.value }),
  });

  const gated = retailTool({
    name: "gated",
    description: "test tool needing auth",
    input: z.object({}),
    summary: () => "ran",
    run: () => ({ ok: true }),
  });

  const failing = retailTool({
    name: "failing",
    description: "test tool that returns an error",
    input: z.object({}),
    requiresAuth: false,
    summary: () => "should not be used",
    run: () => ({ error: "nope" }),
  });

  test("increments callSeq and logs activity on every call", async () => {
    const ctx = makeCtx();
    await echo.run({ value: "a" }, ctx);
    await echo.run({ value: "b" }, ctx);
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(2);
    expect(state.activity.map((a) => a.summary)).toEqual(["echoed a", "echoed b"]);
    expect(state.activity.map((a) => a.tool)).toEqual(["echo", "echo"]);
  });

  test("a repeated identical call still changes the projection", async () => {
    const ctx = makeCtx();
    await echo.run({ value: "same" }, ctx);
    const first = retailSlot.get(ctx).callSeq;
    await echo.run({ value: "same" }, ctx);
    expect(retailSlot.get(ctx).callSeq).toBeGreaterThan(first);
  });

  test("defaults to requiring authentication and does not run the handler when blocked", async () => {
    const ctx = makeCtx();
    const result = await gated.run({}, ctx);
    expect(isToolFailure(result) && result.error).toContain("find_user_id_by_email");
  });

  test("a blocked call is still logged and still bumps callSeq", async () => {
    const ctx = makeCtx();
    await gated.run({}, ctx);
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(1);
    expect(state.activity[0]?.summary).toContain("blocked");
  });

  test("runs once authenticated", async () => {
    const ctx = makeCtx();
    retailSlot.get(ctx).authenticatedUserId = "olivia_ito_3591";
    const result = await gated.run({}, ctx);
    expect(result).toEqual({ ok: true });
  });

  test("an error result is logged as an error, not through summary()", async () => {
    const ctx = makeCtx();
    await failing.run({}, ctx);
    expect(retailSlot.get(ctx).activity[0]?.summary).toBe("error: nope");
  });

  test("activity is capped so a long call cannot grow the payload", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 15; i++) await echo.run({ value: String(i) }, ctx);
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(15);
    expect(state.activity).toHaveLength(10);
    expect(state.activity[0]?.summary).toBe("echoed 5");
  });

  test("concurrent calls serialize — no lost increments", async () => {
    const ctx = makeCtx();
    await Promise.all(Array.from({ length: 8 }, (_, i) => echo.run({ value: String(i) }, ctx)));
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(8);
    expect(new Set(state.activity.map((a) => a.seq)).size).toBe(state.activity.length);
  });
});
