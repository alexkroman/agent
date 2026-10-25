import { isToolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import {
  createToolContext,
  expectDialogRefused,
  expectToolOk,
} from "@alexkroman1/aai-runtime/testing";
import { describe, expect, test } from "vitest";
import {
  authenticatedUser,
  BEFORE_TRANSFER,
  callFlow,
  createDefaultState,
  findItem,
  findOrder,
  findPaymentMethod,
  findProduct,
  findUser,
  findVariant,
  isGiftCard,
  money,
  record,
  requireOwnOrder,
  retailSlot,
  summarize,
} from "./store.ts";

describe("session state", () => {
  test("the slot seeds lazily and returns the same object on re-entry", () => {
    const ctx = createToolContext();
    const a = retailSlot.get(ctx);
    const b = retailSlot.get(ctx);
    expect(a).toBe(b);
    expect(a.authenticatedUserId).toBeNull();
    expect(a.callSeq).toBe(0);
    expect(Object.keys(a.store.orders)).toHaveLength(22);
  });

  test("each session gets its own deep copy — a mutation cannot leak across sessions", () => {
    retailSlot.update(createToolContext(), (first) => {
      const order = first.store.orders["#W9300146"];
      if (!order) throw new Error("fixture missing");
      order.status = "cancelled";
      const giftCard = first.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
      if (giftCard?.source === "gift_card") giftCard.balance = 0;
    });

    const second = retailSlot.get(createToolContext());
    expect(second.store.orders["#W9300146"]?.status).toBe("pending");
    const fresh = second.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(fresh?.source === "gift_card" && fresh.balance).toBe(17);
  });
});

describe("money", () => {
  test("rounds to two decimals", () => {
    expect(money(0.1 + 0.2)).toBe(0.3);
    expect(money(-40.860_000_000_000_014)).toBe(-40.86);
  });

  test("rounds a half-cent the same way the desk PRINTS it", () => {
    // This used to be `Math.round(n * 100) / 100`, and asserted `money(3.005)
    // === 3.01`. The double stored for 3.005 is just under it, so `formatMoney`
    // printed `$3.00` for the same value: the desk compared one number and read
    // out another. `roundMoney` shares `formatMoney`'s basis, so it cannot.
    for (const amount of [3.005, 2.675, 1.115, 19.995]) {
      expect(formatMoney(money(amount))).toBe(formatMoney(amount));
    }
    expect(money(3.005)).toBe(3);
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

describe("the activity feed", () => {
  test("record bumps callSeq and opens a line the completed hook can find", () => {
    const ctx = createToolContext();
    retailSlot.update(ctx, (state) => {
      record(state, "get_order_details", 5, "call_1");
      record(state, "get_order_details", 6, "call_2");
    });
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(2);
    expect(state.activity.map((line) => [line.callId, line.summary])).toEqual([
      ["call_1", "running"],
      ["call_2", "running"],
    ]);
  });

  test("summarize reads the line off what the model was handed", () => {
    expect(summarize(JSON.stringify({ error: "nope" }))).toBe("error: nope");
    expect(
      summarize(
        JSON.stringify({
          state: "serving.awaitingConfirmation",
          done: false,
          result: { read_back: "cancel #W1" },
        }),
      ),
    ).toBe("staged: cancel #W1");
    expect(
      summarize(
        JSON.stringify({
          state: "serving.helping",
          done: false,
          result: { confirmed: "cancel_pending_order" },
        }),
      ),
    ).toBe("confirmed cancel_pending_order");
    expect(summarize(JSON.stringify({ result: { dropped: null } }))).toBe("dropped nothing");
    expect(summarize(JSON.stringify({ result: { order_id: "#W1" } }))).toBe("done");
    expect(summarize("not json")).toBe("done");
  });

  test("activity is capped so a long call cannot grow the payload", () => {
    const ctx = createToolContext();
    retailSlot.update(ctx, (state) => {
      for (let i = 0; i < 15; i++) record(state, "echo", i, `call_${i}`);
    });
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(15);
    expect(state.activity).toHaveLength(10);
    expect(state.activity[0]?.callId).toBe("call_5");
  });
});

describe("the call flow", () => {
  test("a fresh call is identifying, and nothing is latched", () => {
    const ctx = createToolContext();
    expect(callFlow.position(ctx).state).toBe("identifying");
    expect(retailSlot.get(ctx).authenticatedUserId).toBeNull();
  });

  test("transferred is final, so every tool refuses after the handoff", async () => {
    const ctx = createToolContext();
    const anywhere = retailSlot.updateTool({
      description: "legal in every state but the terminal one",
      dialog: callFlow,
      when: BEFORE_TRANSFER,
      execute: () => ({ ok: true }),
    });
    expect(expectToolOk(await anywhere.execute({}, ctx))).toEqual({ ok: true });

    const at = callFlow.send(ctx, { type: "TRANSFERRED" });
    expect(at.state).toBe("transferred");
    expect(at.done).toBe(true);

    expectDialogRefused(await anywhere.execute({}, ctx), "transferred");
  });
});
