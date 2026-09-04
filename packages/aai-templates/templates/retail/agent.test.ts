import type { ToolContext } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import { createToolContext, expectToolOk } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import type { AuthResult } from "./authenticate.ts";
import type { StagedResult } from "./pending.ts";
import type { Address } from "./shared.ts";
import { callFlow, retailSlot } from "./store.ts";
import cancelPendingOrder from "./tools/cancel_pending_order.ts";
import confirmChange from "./tools/confirm_change.ts";
import exchangeDeliveredOrderItems from "./tools/exchange_delivered_order_items.ts";
import findUserIdByEmail from "./tools/find_user_id_by_email.ts";
import findUserIdByNameZip from "./tools/find_user_id_by_name_zip.ts";
import getItemDetails from "./tools/get_item_details.ts";
import getOrderDetails from "./tools/get_order_details.ts";
import getProductDetails from "./tools/get_product_details.ts";
import getUserDetails from "./tools/get_user_details.ts";
import listAllProductTypes from "./tools/list_all_product_types.ts";
import modifyPendingOrderAddress from "./tools/modify_pending_order_address.ts";
import modifyPendingOrderItems from "./tools/modify_pending_order_items.ts";
import modifyPendingOrderPayment from "./tools/modify_pending_order_payment.ts";
import modifyUserAddress from "./tools/modify_user_address.ts";
import returnDeliveredOrderItems from "./tools/return_delivered_order_items.ts";
import transferToHumanAgents from "./tools/transfer_to_human_agents.ts";

/** Each call is its own session, so two contexts are two independent stores —
 *  which is what the isolation tests below rest on. */
function makeCtx(): ToolContext {
  return createToolContext();
}

/** A context already authenticated as `userId`, via the real tool. */
async function authedCtx(email: string): Promise<ToolContext> {
  const ctx = makeCtx();
  expectToolOk<AuthResult>(await findUserIdByEmail.execute({ email }, ctx));
  return ctx;
}

/**
 * Stage a change and say yes — the two calls one caller turn now produces.
 *
 * Nothing in this template mutates before `confirm_change`, so every spec about
 * an APPLIED change has to run both halves. That is not helper ceremony: it is
 * the property under test, and a spec that forgot the second call would find
 * the store untouched. It asserts the readback exists on the way through,
 * because a staged change the agent has no sentence for is the one shape that
 * would let this gate pass while carrying nothing to confirm.
 */
async function confirmed<R = unknown>(staged: unknown, ctx: ToolContext): Promise<R> {
  const stage = expectToolOk<StagedResult>(staged);
  // A throw rather than an `expect`, which biome's `noMisplacedAssertion`
  // rightly refuses outside a test body. A staged change with no sentence to
  // read back is the one shape that would let the gate pass while carrying
  // nothing to confirm, so it stops the spec here rather than downstream.
  if (stage.read_back.length === 0) throw new Error(`${stage.staged} staged with no readback`);
  return expectToolOk<R>(await confirmChange.execute({}, ctx));
}

describe("authentication", () => {
  test("find_user_id_by_email is case-insensitive and authenticates the session", async () => {
    const ctx = makeCtx();
    const result = expectToolOk<AuthResult>(
      await findUserIdByEmail.execute({ email: "OLIVIA.ITO5204@EXAMPLE.COM" }, ctx),
    );
    expect(result.user_id).toBe("olivia_ito_3591");
    expect(retailSlot.get(ctx).authenticatedUserId).toBe("olivia_ito_3591");
    // Two facts, two homes: the store latches WHO, the flow holds WHETHER.
    // `serving` is a parent now, so an identified call reports its child.
    expect(callFlow.position(ctx).state).toBe("serving.helping");
  });

  test("an unknown email is refused and leaves the session unauthenticated", async () => {
    const ctx = makeCtx();
    const result = await findUserIdByEmail.execute({ email: "nobody@example.com" }, ctx);
    expect(isToolFailure(result)).toBe(true);
    expect(retailSlot.get(ctx).authenticatedUserId).toBeNull();
    // `IDENTIFIED` is not sent when the body answers a `ToolFailure`, so a
    // lookup that found nobody cannot leave the call one step ahead of itself.
    expect(callFlow.position(ctx).state).toBe("identifying");
  });

  test("find_user_id_by_name_zip is case-insensitive on names and exact on zip", async () => {
    const ctx = makeCtx();
    const found = expectToolOk<AuthResult>(
      await findUserIdByNameZip.execute(
        { first_name: "aarav", last_name: "ANDERSON", zip: "19031" },
        ctx,
      ),
    );
    expect(found.user_id).toBe("aarav_anderson_8794");

    const wrongZip = await findUserIdByNameZip.execute(
      { first_name: "Aarav", last_name: "Anderson", zip: "78268" },
      makeCtx(),
    );
    expect(isToolFailure(wrongZip)).toBe(true);
  });

  test("two customers share a first name — the zip is what separates them", async () => {
    const a = expectToolOk<AuthResult>(
      await findUserIdByNameZip.execute(
        { first_name: "Aarav", last_name: "Anderson", zip: "19031" },
        makeCtx(),
      ),
    );
    const b = expectToolOk<AuthResult>(
      await findUserIdByNameZip.execute(
        { first_name: "Aarav", last_name: "Gonzalez", zip: "78268" },
        makeCtx(),
      ),
    );
    expect(a.user_id).toBe("aarav_anderson_8794");
    expect(b.user_id).toBe("aarav_gonzalez_5113");
  });

  test("re-authenticating as the same customer is a no-op success", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const again = await findUserIdByEmail.execute({ email: "olivia.ito5204@example.com" }, ctx);
    expect(isToolFailure(again)).toBe(false);
    expect(retailSlot.get(ctx).authenticatedUserId).toBe("olivia_ito_3591");
  });

  test("switching to a DIFFERENT customer mid-conversation is refused", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const switched = await findUserIdByEmail.execute(
      { email: "aarav.anderson9752@example.com" },
      ctx,
    );
    expect(isToolFailure(switched) && switched.error.toLowerCase()).toContain("one customer");
    expect(retailSlot.get(ctx).authenticatedUserId).toBe("olivia_ito_3591");
    // The tool is legal in `serving` — the refusal comes from `authenticateAs`,
    // not from the gate — so the call stays exactly where it was.
    expect(callFlow.position(ctx).state).toBe("serving.helping");
  });

  test("switching via name + zip is refused too — both doors, one lock", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const switched = await findUserIdByNameZip.execute(
      { first_name: "Aarav", last_name: "Anderson", zip: "19031" },
      ctx,
    );
    expect(isToolFailure(switched)).toBe(true);
    expect(retailSlot.get(ctx).authenticatedUserId).toBe("olivia_ito_3591");
  });
});

interface UserDetailsResult {
  user_id: string;
  email: string;
  orders: { order_id: string; status: string }[];
  payment_methods: { payment_method_id: string; source: string; balance?: number }[];
}

interface OrderDetailsResult {
  order_id: string;
}

interface ProductDetailsResult {
  name: string;
  variants: { item_id: string }[];
}

interface ItemDetailsResult {
  price: number;
  product_name: string;
}

interface ProductTypesResult {
  products: Record<string, string>;
}

describe("read tools", () => {
  test("get_user_details returns the caller's profile with gift-card balances", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = expectToolOk<UserDetailsResult>(
      await getUserDetails.execute({ user_id: "olivia_ito_3591" }, ctx),
    );
    expect(result.email).toBe("olivia.ito5204@example.com");
    expect(result.orders).toHaveLength(5);
    const card = result.payment_methods.find((m) => m.payment_method_id === "gift_card_7794233");
    expect(card?.balance).toBe(56);
  });

  test("get_user_details refuses a different user id", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await getUserDetails.execute({ user_id: "aarav_anderson_8794" }, ctx);
    expect(isToolFailure(result)).toBe(true);
  });

  test("get_order_details resolves shorthand and sets focus", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = expectToolOk<OrderDetailsResult>(
      await getOrderDetails.execute({ order_id: "the delivered one" }, ctx),
    );
    expect(result.order_id).toBe("#W5866402");
    expect(retailSlot.get(ctx).focus.orderId).toBe("#W5866402");
  });

  test("get_order_details refuses another customer's order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await getOrderDetails.execute({ order_id: "#W4316152" }, ctx);
    expect(isToolFailure(result)).toBe(true);
  });

  test("get_product_details lists variants and needs no authentication", async () => {
    const result = expectToolOk<ProductDetailsResult>(
      await getProductDetails.execute({ product_id: "9832717871" }, makeCtx()),
    );
    expect(result.name).toBe("Tea Kettle");
    expect(result.variants.length).toBeGreaterThan(1);
    expect(result.variants[0]).toHaveProperty("item_id");
  });

  test("get_product_details rejects an item id passed as a product id, and says so", async () => {
    const result = await getProductDetails.execute({ product_id: "3909406921" }, makeCtx());
    expect(isToolFailure(result) && result.error).toContain("item id");
  });

  test("get_item_details resolves an item without knowing its product", async () => {
    const result = expectToolOk<ItemDetailsResult>(
      await getItemDetails.execute({ item_id: "3909406921" }, makeCtx()),
    );
    expect(result.price).toBe(98.25);
    expect(result.product_name).toBe("Tea Kettle");
  });

  test("list_all_product_types returns all 50, sorted by name", async () => {
    const result = expectToolOk<ProductTypesResult>(
      await listAllProductTypes.execute({}, makeCtx()),
    );
    expect(Object.keys(result.products)).toHaveLength(50);
    const names = Object.keys(result.products);
    // localeCompare, not the default lexicographic sort — the tool sorts for a
    // human reading the catalog, e.g. "Laptop" before "LED Light Bulb" ('a' < 'E'
    // by locale, but not by UTF-16 code unit).
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

interface CancelOrderResult {
  order_id: string;
  status: string;
  cancel_reason: string;
  refunded: number;
  refund_immediate: boolean;
  message: string;
}

describe("cancel_pending_order", () => {
  test("cancels a pending order and credits a gift card immediately", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await confirmed<CancelOrderResult>(
      await cancelPendingOrder.execute(
        { order_id: "#W9300146", reason: "ordered by mistake" },
        ctx,
      ),
      ctx,
    );
    expect(result.status).toBe("cancelled");
    expect(result.refund_immediate).toBe(true);

    const state = retailSlot.get(ctx);
    expect(state.store.orders["#W9300146"]?.status).toBe("cancelled");
    expect(state.store.orders["#W9300146"]?.cancel_reason).toBe("ordered by mistake");
    // $17.00 card + the $153.23 order total.
    const card = state.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(170.23);
  });

  test("appends a matching refund to the payment history", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await confirmed(
      await cancelPendingOrder.execute({ order_id: "#W9300146", reason: "no longer needed" }, ctx),
      ctx,
    );
    const history = retailSlot.get(ctx).store.orders["#W9300146"]?.payment_history ?? [];
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      transaction_type: "refund",
      amount: 153.23,
      payment_method_id: "gift_card_7245904",
    });
  });

  test("a non-gift-card refund takes 5-7 days and moves no balance", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await confirmed<CancelOrderResult>(
      await cancelPendingOrder.execute({ order_id: "#W5442520", reason: "no longer needed" }, ctx),
      ctx,
    );
    expect(result.refund_immediate).toBe(false);
    expect(result.message).toContain("5 to 7");
    const card = retailSlot.get(ctx).store.users.olivia_ito_3591?.payment_methods.gift_card_7794233;
    expect(card?.source === "gift_card" && card.balance).toBe(56);
  });

  test("refuses a processed order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await cancelPendingOrder.execute(
      { order_id: "#W5353646", reason: "no longer needed" },
      ctx,
    );
    expect(isToolFailure(result) && result.error).toContain("processed");
    expect(retailSlot.get(ctx).store.orders["#W5353646"]?.status).toBe("processed");
  });

  test("refuses a delivered order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await cancelPendingOrder.execute(
      { order_id: "#W5866402", reason: "no longer needed" },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("refuses a reason outside tau2's two accepted values", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    // The schema's `reason` field is a two-value enum, so a well-typed caller
    // can never construct this input — this simulates the wire boundary
    // (an LLM tool call is untyped) rather than a call TS would allow.
    const result = await cancelPendingOrder.execute(
      { order_id: "#W9300146", reason: "changed my mind" as unknown as "no longer needed" },
      ctx,
    );
    expect(isToolFailure(result) && result.error).toContain("no longer needed");
    expect(retailSlot.get(ctx).store.orders["#W9300146"]?.status).toBe("pending");
  });

  test("refuses cancelling twice", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await confirmed(
      await cancelPendingOrder.execute({ order_id: "#W9300146", reason: "no longer needed" }, ctx),
      ctx,
    );
    const second = await cancelPendingOrder.execute(
      { order_id: "#W9300146", reason: "no longer needed" },
      ctx,
    );
    expect(isToolFailure(second)).toBe(true);
    const card =
      retailSlot.get(ctx).store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(170.23);
  });

  test("resolves spoken shorthand to the single pending order", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await confirmed<CancelOrderResult>(
      await cancelPendingOrder.execute(
        { order_id: "my pending order", reason: "ordered by mistake" },
        ctx,
      ),
      ctx,
    );
    expect(result.order_id).toBe("#W9300146");
  });

  test("refuses ambiguous shorthand rather than cancelling the wrong order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await cancelPendingOrder.execute(
      { order_id: "my pending order", reason: "no longer needed" },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
    const statuses = ["#W5442520", "#W7941031", "#W3657213"].map(
      (id) => retailSlot.get(ctx).store.orders[id]?.status,
    );
    expect(statuses).toEqual(["pending", "pending", "pending"]);
  });
});

const NEW_ADDRESS = {
  address1: "742 Evergreen Terrace",
  address2: "Apt 4",
  city: "Springfield",
  state: "OR",
  country: "USA",
  zip: "97477",
};

interface AddressToolResult {
  order_id: string;
  address: Address;
}

describe("modify_pending_order_address", () => {
  test("rewrites a pending order's shipping address", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await confirmed<AddressToolResult>(
      await modifyPendingOrderAddress.execute({ order_id: "#W9300146", ...NEW_ADDRESS }, ctx),
      ctx,
    );
    expect(result.address).toEqual(NEW_ADDRESS);
    expect(retailSlot.get(ctx).store.orders["#W9300146"]?.address).toEqual(NEW_ADDRESS);
  });

  test("leaves the customer's default address untouched", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await confirmed(
      await modifyPendingOrderAddress.execute({ order_id: "#W9300146", ...NEW_ADDRESS }, ctx),
      ctx,
    );
    expect(retailSlot.get(ctx).store.users.aarav_anderson_8794?.address.zip).toBe("19031");
  });

  test("accepts a 'pending (item modified)' order — unlike cancel", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    retailSlot.update(ctx, (state) => {
      const order = state.store.orders["#W9300146"];
      if (!order) throw new Error("fixture missing");
      order.status = "pending (item modified)";
    });
    const result = await modifyPendingOrderAddress.execute(
      { order_id: "#W9300146", ...NEW_ADDRESS },
      ctx,
    );
    expect(isToolFailure(result)).toBe(false);
  });

  test("refuses a delivered order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await modifyPendingOrderAddress.execute(
      { order_id: "#W5866402", ...NEW_ADDRESS },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("refuses another customer's order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await modifyPendingOrderAddress.execute(
      { order_id: "#W9300146", ...NEW_ADDRESS },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });
});

describe("modify_user_address", () => {
  test("rewrites the customer's default address", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    await confirmed(
      await modifyUserAddress.execute({ user_id: "emma_smith_8564", ...NEW_ADDRESS }, ctx),
      ctx,
    );
    expect(retailSlot.get(ctx).store.users.emma_smith_8564?.address).toEqual(NEW_ADDRESS);
  });

  test("leaves existing orders' addresses untouched", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    const before = structuredClone(retailSlot.get(ctx).store.orders["#W2417020"]?.address);
    await confirmed(
      await modifyUserAddress.execute({ user_id: "emma_smith_8564", ...NEW_ADDRESS }, ctx),
      ctx,
    );
    expect(retailSlot.get(ctx).store.orders["#W2417020"]?.address).toEqual(before);
  });

  test("refuses a different user id", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    const result = await modifyUserAddress.execute(
      { user_id: "olivia_ito_3591", ...NEW_ADDRESS },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
    expect(retailSlot.get(ctx).store.users.olivia_ito_3591?.address.zip).toBe("80218");
  });

  test("requires authentication", async () => {
    const result = await modifyUserAddress.execute(
      { user_id: "emma_smith_8564", ...NEW_ADDRESS },
      makeCtx(),
    );
    expect(isToolFailure(result) && result.error).toContain("find_user_id_by_email");
  });
});

interface ModifyItemsResult {
  order_id: string;
  status: string;
  price_difference: number;
  items: { name: string; item_id: string; options: Record<string, string>; price: number }[];
  message: string;
}

describe("modify_pending_order_items", () => {
  test("swaps an item, charges the difference to a gift card, and goes terminal", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    const result = await confirmed<ModifyItemsResult>(
      await modifyPendingOrderItems.execute(
        {
          order_id: "#W2417020",
          item_ids: ["8997785118"],
          new_item_ids: ["6017636844"],
          payment_method_id: "gift_card_8541487",
        },
        ctx,
      ),
      ctx,
    );
    expect(result.price_difference).toBe(-382.03);
    expect(result.status).toBe("pending (item modified)");

    const state = retailSlot.get(ctx);
    const order = state.store.orders["#W2417020"];
    expect(order?.items[0]?.item_id).toBe("6017636844");
    expect(order?.items[0]?.price).toBe(2292.37);
    // $62.00 card refunded $382.03.
    const card = state.store.users.emma_smith_8564?.payment_methods.gift_card_8541487;
    expect(card?.source === "gift_card" && card.balance).toBe(444.03);
  });

  test("records the difference as a refund entry when the new item is cheaper", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    await confirmed(
      await modifyPendingOrderItems.execute(
        {
          order_id: "#W2417020",
          item_ids: ["8997785118"],
          new_item_ids: ["6017636844"],
          payment_method_id: "gift_card_8541487",
        },
        ctx,
      ),
      ctx,
    );
    const history = retailSlot.get(ctx).store.orders["#W2417020"]?.payment_history ?? [];
    expect(history[1]).toMatchObject({
      transaction_type: "refund",
      amount: 382.03,
      payment_method_id: "gift_card_8541487",
    });
  });

  test("refuses a second modification — the status is terminal", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    await confirmed(
      await modifyPendingOrderItems.execute(
        {
          order_id: "#W2417020",
          item_ids: ["8997785118"],
          new_item_ids: ["6017636844"],
          payment_method_id: "gift_card_8541487",
        },
        ctx,
      ),
      ctx,
    );
    const second = await modifyPendingOrderItems.execute(
      {
        order_id: "#W2417020",
        item_ids: ["6017636844"],
        new_item_ids: ["9844888101"],
        payment_method_id: "gift_card_8541487",
      },
      ctx,
    );
    expect(isToolFailure(second) && second.error).toContain("pending (item modified)");
  });

  test("a modified order can no longer be cancelled", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    await confirmed(
      await modifyPendingOrderItems.execute(
        {
          order_id: "#W2417020",
          item_ids: ["8997785118"],
          new_item_ids: ["6017636844"],
          payment_method_id: "gift_card_8541487",
        },
        ctx,
      ),
      ctx,
    );
    const cancelled = await cancelPendingOrder.execute(
      { order_id: "#W2417020", reason: "no longer needed" },
      ctx,
    );
    expect(isToolFailure(cancelled)).toBe(true);
  });

  test("refuses when the gift card cannot cover the difference, changing nothing", async () => {
    // anya_garcia holds a $51.00 gift card. Upgrading the Laptop in her pending
    // order #W6436609 from 6017636844 ($2292.37) to 9844888101 ($2459.74) is
    // +$167.37 — the NEAREST available upgrade, so the seed trim always keeps
    // it, and it is well past the balance.
    const ctx = await authedCtx("anya.garcia2061@example.com");
    const result = await modifyPendingOrderItems.execute(
      {
        order_id: "#W6436609",
        item_ids: ["6017636844"],
        new_item_ids: ["9844888101"],
        payment_method_id: "gift_card_4374071",
      },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("balance");

    const state = retailSlot.get(ctx);
    const order = state.store.orders["#W6436609"];
    expect(order?.status).toBe("pending");
    expect(order?.items.map((i) => i.item_id)).toContain("6017636844");
    expect(order?.payment_history).toHaveLength(1);
    const card = state.store.users.anya_garcia_3271?.payment_methods.gift_card_4374071;
    expect(card?.source === "gift_card" && card.balance).toBe(51);
  });

  test("the same upgrade succeeds on a payment method with no balance to run out of", async () => {
    const ctx = await authedCtx("anya.garcia2061@example.com");
    const result = await confirmed<ModifyItemsResult>(
      await modifyPendingOrderItems.execute(
        {
          order_id: "#W6436609",
          item_ids: ["6017636844"],
          new_item_ids: ["9844888101"],
          payment_method_id: "credit_card_8955149",
        },
        ctx,
      ),
      ctx,
    );
    expect(result.price_difference).toBe(167.37);
    const history = retailSlot.get(ctx).store.orders["#W6436609"]?.payment_history ?? [];
    expect(history[1]).toMatchObject({
      transaction_type: "payment",
      amount: 167.37,
      payment_method_id: "credit_card_8955149",
    });
  });

  test("refuses a delivered order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await modifyPendingOrderItems.execute(
      {
        order_id: "#W5866402",
        item_ids: ["6242772310"],
        new_item_ids: ["6200867091"],
        payment_method_id: "gift_card_7794233",
      },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("refuses a payment method belonging to another customer", async () => {
    const ctx = await authedCtx("emma.smith3991@example.com");
    const result = await modifyPendingOrderItems.execute(
      {
        order_id: "#W2417020",
        item_ids: ["8997785118"],
        new_item_ids: ["6017636844"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
    expect(retailSlot.get(ctx).store.orders["#W2417020"]?.status).toBe("pending");
  });
});

interface ModifyPaymentResult {
  order_id: string;
  status: string;
  amount: number;
  paid_with: string;
  refunded_to: string;
  message: string;
}

describe("modify_pending_order_payment", () => {
  test("moves an order to a different method, refunding the old one", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    // #W5442520 is $663.85 on credit_card_9753331. Pay by PayPal instead.
    const result = await confirmed<ModifyPaymentResult>(
      await modifyPendingOrderPayment.execute(
        { order_id: "#W5442520", payment_method_id: "paypal_8049766" },
        ctx,
      ),
      ctx,
    );
    expect(result.status).toBe("pending");

    const history = retailSlot.get(ctx).store.orders["#W5442520"]?.payment_history ?? [];
    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({
      transaction_type: "payment",
      amount: 663.85,
      payment_method_id: "paypal_8049766",
    });
    expect(history[2]).toMatchObject({
      transaction_type: "refund",
      amount: 663.85,
      payment_method_id: "credit_card_9753331",
    });
  });

  test("refunds a gift card that was the original method", async () => {
    const ctx = await authedCtx("aarav.gonzalez9269@example.com");
    // #W9160732 is $1011.54 on gift_card_5979071 ($96.00). Move to PayPal.
    await confirmed(
      await modifyPendingOrderPayment.execute(
        { order_id: "#W9160732", payment_method_id: "paypal_6121064" },
        ctx,
      ),
      ctx,
    );
    const card =
      retailSlot.get(ctx).store.users.aarav_gonzalez_5113?.payment_methods.gift_card_5979071;
    expect(card?.source === "gift_card" && card.balance).toBe(1107.54);
  });

  test("refuses a gift card that cannot cover the whole order", async () => {
    const ctx = await authedCtx("aarav.gonzalez9269@example.com");
    // #W6979932 is $1291.82 on PayPal; the gift card holds $96.00.
    const result = await modifyPendingOrderPayment.execute(
      { order_id: "#W6979932", payment_method_id: "gift_card_5979071" },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("balance");
    const card =
      retailSlot.get(ctx).store.users.aarav_gonzalez_5113?.payment_methods.gift_card_5979071;
    expect(card?.source === "gift_card" && card.balance).toBe(96);
    expect(retailSlot.get(ctx).store.orders["#W6979932"]?.payment_history).toHaveLength(1);
  });

  test("refuses the method the order already uses", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await modifyPendingOrderPayment.execute(
      { order_id: "#W5442520", payment_method_id: "credit_card_9753331" },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("different");
  });

  test("refuses an order whose payment history is not a single payment", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    // No seeded pending order has a second history entry, so construct one —
    // tau2 guards this case and the guard should still be covered.
    retailSlot.update(ctx, (state) => {
      const order = state.store.orders["#W5442520"];
      if (!order) throw new Error("fixture missing");
      order.payment_history.push({
        transaction_type: "refund",
        amount: 10,
        payment_method_id: "credit_card_9753331",
      });
    });
    const result = await modifyPendingOrderPayment.execute(
      { order_id: "#W5442520", payment_method_id: "paypal_8049766" },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("exactly one payment");
  });

  test("refuses a delivered order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await modifyPendingOrderPayment.execute(
      { order_id: "#W5866402", payment_method_id: "gift_card_7794233" },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("refuses a method not on the customer's profile", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await modifyPendingOrderPayment.execute(
      { order_id: "#W5442520", payment_method_id: "gift_card_7245904" },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });
});

interface ReturnResult {
  order_id: string;
  status: string;
  return_items: string[];
  refund_to: string;
  message: string;
}

interface ExchangeResult {
  order_id: string;
  status: string;
  price_difference: number;
  exchanges: { item_id: string; new_item_id: string; price_difference: number }[];
  message: string;
}

describe("return_delivered_order_items", () => {
  test("requests a return refunded to the original method", async () => {
    const ctx = await authedCtx("harper.brown3965@example.com");
    const result = await confirmed<ReturnResult>(
      await returnDeliveredOrderItems.execute(
        {
          order_id: "#W1840144",
          item_ids: ["8590708195"],
          payment_method_id: "paypal_2306935",
        },
        ctx,
      ),
      ctx,
    );
    expect(result.status).toBe("return requested");
    const order = retailSlot.get(ctx).store.orders["#W1840144"];
    expect(order?.return_items).toEqual(["8590708195"]);
    expect(order?.return_payment_method_id).toBe("paypal_2306935");
  });

  test("accepts a gift card that was NOT the original method", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    // #W5866402 was paid by PayPal; olivia also holds a gift card.
    const result = await returnDeliveredOrderItems.execute(
      {
        order_id: "#W5866402",
        item_ids: ["9727387530"],
        payment_method_id: "gift_card_7794233",
      },
      ctx,
    );
    expect(isToolFailure(result)).toBe(false);
  });

  test("refuses a non-original, non-gift-card method", async () => {
    const ctx = await authedCtx("harper.brown3965@example.com");
    // Paid by PayPal; harper holds no gift card, so the credit card is illegal.
    const result = await returnDeliveredOrderItems.execute(
      {
        order_id: "#W1840144",
        item_ids: ["8590708195"],
        payment_method_id: "credit_card_3240550",
      },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("original");
    expect(retailSlot.get(ctx).store.orders["#W1840144"]?.status).toBe("delivered");
  });

  test("returns both copies of a duplicate item, in the order they were named", async () => {
    const ctx = await authedCtx("harper.brown3965@example.com");
    await confirmed(
      await returnDeliveredOrderItems.execute(
        {
          order_id: "#W1840144",
          item_ids: ["8590708195", "6534134392", "8590708195"],
          payment_method_id: "paypal_2306935",
        },
        ctx,
      ),
      ctx,
    );
    // Not sorted. tau2 sorted this list to match an expected end state and
    // nothing compares against one any more, so it holds the caller's own
    // order — which is the order the readback said them in.
    expect(retailSlot.get(ctx).store.orders["#W1840144"]?.return_items).toEqual([
      "8590708195",
      "6534134392",
      "8590708195",
    ]);
  });

  test("refuses more copies than the order holds", async () => {
    const ctx = await authedCtx("harper.brown3965@example.com");
    const result = await returnDeliveredOrderItems.execute(
      {
        order_id: "#W1840144",
        item_ids: ["6534134392", "6534134392"],
        payment_method_id: "paypal_2306935",
      },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("refuses a pending order and refuses a second return", async () => {
    const ctx = await authedCtx("harper.brown3965@example.com");
    const pending = await returnDeliveredOrderItems.execute(
      {
        order_id: "#W2273069",
        item_ids: ["3909406921"],
        payment_method_id: "credit_card_3240550",
      },
      ctx,
    );
    expect(isToolFailure(pending)).toBe(true);

    await confirmed(
      await returnDeliveredOrderItems.execute(
        { order_id: "#W1840144", item_ids: ["8590708195"], payment_method_id: "paypal_2306935" },
        ctx,
      ),
      ctx,
    );
    const again = await returnDeliveredOrderItems.execute(
      { order_id: "#W1840144", item_ids: ["6534134392"], payment_method_id: "paypal_2306935" },
      ctx,
    );
    expect(isToolFailure(again) && again.error).toContain("return requested");
  });
});

describe("exchange_delivered_order_items", () => {
  test("records an exchange with a positive price difference", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await confirmed<ExchangeResult>(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796"],
          new_item_ids: ["3909406921"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
      ctx,
    );
    expect(result.price_difference).toBe(3.45);
    expect(result.exchanges).toEqual([
      { item_id: "7292993796", new_item_id: "3909406921", price_difference: 3.45 },
    ]);
    const order = retailSlot.get(ctx).store.orders["#W4316152"];
    expect(order?.status).toBe("exchange requested");
    expect(order?.exchange_items).toEqual(["7292993796"]);
    expect(order?.exchange_new_items).toEqual(["3909406921"]);
    expect(order?.exchange_price_difference).toBe(3.45);
  });

  test("the stored fields hold the pairing that was priced, not two sorted sets", async () => {
    // `#W5866402` is the case that makes the difference visible: the two
    // requested replacements sort into the OTHER order. tau2 stored
    // `sorted(item_ids)` / `sorted(new_item_ids)`, which read as
    // espresso -> sneaker if anything treated them as a pairing — so the result
    // had to carry the real pairing separately, and the stored fields were a
    // trap for the next reader. Nothing is compared against a tau2 end state
    // any more, so both hold what `planItemSwap` actually priced.
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await confirmed<ExchangeResult>(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W5866402",
          item_ids: ["6242772310", "9727387530"],
          new_item_ids: ["7407838442", "2509076505"],
          payment_method_id: "paypal_8049766",
        },
        ctx,
      ),
      ctx,
    );

    expect(result.exchanges).toEqual([
      { item_id: "6242772310", new_item_id: "7407838442", price_difference: 85.88 },
      { item_id: "9727387530", new_item_id: "2509076505", price_difference: -18.25 },
    ]);
    // The per-line differences add up to the quoted total — which is what makes
    // the answer internally consistent rather than two numbers side by side.
    expect(result.exchanges.reduce((sum, one) => sum + one.price_difference, 0)).toBeCloseTo(
      result.price_difference,
      5,
    );

    // Positionally aligned with each other AND with `result.exchanges`.
    const order = retailSlot.get(ctx).store.orders["#W5866402"];
    expect(order?.exchange_items).toEqual(["6242772310", "9727387530"]);
    expect(order?.exchange_new_items).toEqual(["7407838442", "2509076505"]);
  });

  test("does NOT move the gift-card balance — it is a request, not a settlement", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await confirmed(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796"],
          new_item_ids: ["3909406921"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
      ctx,
    );
    const card =
      retailSlot.get(ctx).store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(17);
  });

  test("leaves the order's items unchanged until the exchange is fulfilled", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await confirmed(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796"],
          new_item_ids: ["3909406921"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
      ctx,
    );
    expect(retailSlot.get(ctx).store.orders["#W4316152"]?.items.map((i) => i.item_id)).toEqual([
      "7292993796",
      "7292993796",
    ]);
  });

  test("exchanges both copies of a duplicate and doubles the difference", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await confirmed<ExchangeResult>(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796", "7292993796"],
          new_item_ids: ["3909406921", "3909406921"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
      ctx,
    );
    expect(result.price_difference).toBe(6.9);
  });

  test("records a negative difference as a refund direction", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await confirmed<ExchangeResult>(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W5866402",
          item_ids: ["6242772310"],
          new_item_ids: ["6200867091"],
          payment_method_id: "gift_card_7794233",
        },
        ctx,
      ),
      ctx,
    );
    expect(result.price_difference).toBe(-40.86);
  });

  test("refuses a gift card that cannot cover the difference", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await exchangeDeliveredOrderItems.execute(
      {
        order_id: "#W9311069",
        item_ids: ["1304426904"],
        new_item_ids: ["4725166838"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("balance");
    expect(retailSlot.get(ctx).store.orders["#W9311069"]?.status).toBe("delivered");
  });

  test("refuses a cross-product swap", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await exchangeDeliveredOrderItems.execute(
      {
        order_id: "#W4316152",
        item_ids: ["7292993796"],
        new_item_ids: ["4725166838"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("refuses an unavailable target", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = await exchangeDeliveredOrderItems.execute(
      {
        order_id: "#W4316152",
        item_ids: ["7292993796"],
        new_item_ids: ["6454334990"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(result) && result.error.toLowerCase()).toContain("not available");
  });

  test("refuses a pending order and refuses a second exchange", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const pending = await exchangeDeliveredOrderItems.execute(
      {
        order_id: "#W9300146",
        item_ids: ["9190635437"],
        new_item_ids: ["9190635437"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(pending)).toBe(true);

    await confirmed(
      await exchangeDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796"],
          new_item_ids: ["3909406921"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
      ctx,
    );
    const again = await exchangeDeliveredOrderItems.execute(
      {
        order_id: "#W4316152",
        item_ids: ["7292993796"],
        new_item_ids: ["3738831434"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(again)).toBe(true);
  });

  test("a returned order can no longer be exchanged", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await confirmed(
      await returnDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
      ctx,
    );
    const result = await exchangeDeliveredOrderItems.execute(
      {
        order_id: "#W4316152",
        item_ids: ["7292993796"],
        new_item_ids: ["3909406921"],
        payment_method_id: "gift_card_7245904",
      },
      ctx,
    );
    expect(isToolFailure(result)).toBe(true);
  });
});

interface TransferResult {
  transferred: boolean;
  summary: string;
  message: string;
}

describe("transfer_to_human_agents", () => {
  test("works without authentication — the escape hatch cannot be gated", async () => {
    const result = expectToolOk<TransferResult>(
      await transferToHumanAgents.execute(
        { summary: "Caller wants to dispute a charge from 2019." },
        makeCtx(),
      ),
    );
    expect(isToolFailure(result)).toBe(false);
    expect(result.transferred).toBe(true);
  });

  test("the handoff is terminal, so the call cannot be worked afterwards", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    expectToolOk(await transferToHumanAgents.execute({ summary: "wants a human" }, ctx));

    const at = callFlow.position(ctx);
    expect(at.state).toBe("transferred");
    expect(at.done).toBe(true);

    // The policy's "say nothing else after that" used to be enforced by
    // nothing: every tool stayed callable, so a model that kept going kept
    // acting on a call it had given away.
    const refused = await getUserDetails.execute({ user_id: "olivia_ito_3591" }, ctx);
    expect(isToolFailure(refused)).toBe(true);
    expect(isToolFailure(refused) && refused.error).toContain('"transferred"');
  });
});
