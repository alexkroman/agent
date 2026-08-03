import type { ToolContext } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import type { AuthResult } from "./authenticate.ts";
import type { ErrorResult } from "./store.ts";
import { getState, isError } from "./store.ts";
import { cancelPendingOrder } from "./tools/cancel_pending_order.ts";
import { findUserIdByEmail } from "./tools/find_user_id_by_email.ts";
import { findUserIdByNameZip } from "./tools/find_user_id_by_name_zip.ts";
import { getItemDetails } from "./tools/get_item_details.ts";
import { getOrderDetails } from "./tools/get_order_details.ts";
import { getProductDetails } from "./tools/get_product_details.ts";
import { getUserDetails } from "./tools/get_user_details.ts";
import { listAllProductTypes } from "./tools/list_all_product_types.ts";

let sessionCounter = 0;

function makeCtx(): ToolContext {
  return {
    sessionId: `retail-test-${++sessionCounter}`,
    send: () => {},
    env: {},
    state: {},
    messages: [],
  } as unknown as ToolContext;
}

/** A context already authenticated as `userId`, via the real tool. */
async function authedCtx(email: string): Promise<ToolContext> {
  const ctx = makeCtx();
  // `ToolDef["execute"]`'s public signature always returns `unknown` (the
  // wire type is fixed so any tool is assignable to `ToolDef`, regardless of
  // what its own `execute` body actually returns), so a cast is needed
  // anywhere a test reads a success field back off the result — matching the
  // `as {...}` convention other templates already use for the same reason.
  const result = (await findUserIdByEmail.execute({ email }, ctx)) as AuthResult | ErrorResult;
  if (isError(result)) throw new Error(`fixture failed to authenticate: ${result.error}`);
  return ctx;
}

describe("authentication", () => {
  test("find_user_id_by_email is case-insensitive and authenticates the session", async () => {
    const ctx = makeCtx();
    const result = (await findUserIdByEmail.execute(
      { email: "OLIVIA.ITO5204@EXAMPLE.COM" },
      ctx,
    )) as AuthResult | ErrorResult;
    expect(isError(result) ? null : result.user_id).toBe("olivia_ito_3591");
    expect(getState(ctx).authenticatedUserId).toBe("olivia_ito_3591");
  });

  test("an unknown email is refused and leaves the session unauthenticated", async () => {
    const ctx = makeCtx();
    const result = await findUserIdByEmail.execute({ email: "nobody@example.com" }, ctx);
    expect(isError(result)).toBe(true);
    expect(getState(ctx).authenticatedUserId).toBeNull();
  });

  test("find_user_id_by_name_zip is case-insensitive on names and exact on zip", async () => {
    const ctx = makeCtx();
    const ok = (await findUserIdByNameZip.execute(
      { first_name: "aarav", last_name: "ANDERSON", zip: "19031" },
      ctx,
    )) as AuthResult | ErrorResult;
    expect(isError(ok) ? null : ok.user_id).toBe("aarav_anderson_8794");

    const wrongZip = await findUserIdByNameZip.execute(
      { first_name: "Aarav", last_name: "Anderson", zip: "78268" },
      makeCtx(),
    );
    expect(isError(wrongZip)).toBe(true);
  });

  test("two customers share a first name — the zip is what separates them", async () => {
    const a = (await findUserIdByNameZip.execute(
      { first_name: "Aarav", last_name: "Anderson", zip: "19031" },
      makeCtx(),
    )) as AuthResult | ErrorResult;
    const b = (await findUserIdByNameZip.execute(
      { first_name: "Aarav", last_name: "Gonzalez", zip: "78268" },
      makeCtx(),
    )) as AuthResult | ErrorResult;
    expect(isError(a) ? null : a.user_id).toBe("aarav_anderson_8794");
    expect(isError(b) ? null : b.user_id).toBe("aarav_gonzalez_5113");
  });

  test("re-authenticating as the same customer is a no-op success", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const again = await findUserIdByEmail.execute({ email: "olivia.ito5204@example.com" }, ctx);
    expect(isError(again)).toBe(false);
    expect(getState(ctx).authenticatedUserId).toBe("olivia_ito_3591");
  });

  test("switching to a DIFFERENT customer mid-conversation is refused", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const switched = await findUserIdByEmail.execute(
      { email: "aarav.anderson9752@example.com" },
      ctx,
    );
    expect(isError(switched) && switched.error.toLowerCase()).toContain("one customer");
    expect(getState(ctx).authenticatedUserId).toBe("olivia_ito_3591");
  });

  test("switching via name + zip is refused too — both doors, one lock", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const switched = await findUserIdByNameZip.execute(
      { first_name: "Aarav", last_name: "Anderson", zip: "19031" },
      ctx,
    );
    expect(isError(switched)).toBe(true);
    expect(getState(ctx).authenticatedUserId).toBe("olivia_ito_3591");
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
    const result = (await getUserDetails.execute({ user_id: "olivia_ito_3591" }, ctx)) as
      | UserDetailsResult
      | ErrorResult;
    if (isError(result)) throw new Error(result.error);
    expect(result.email).toBe("olivia.ito5204@example.com");
    expect(result.orders).toHaveLength(5);
    const card = result.payment_methods.find((m) => m.payment_method_id === "gift_card_7794233");
    expect(card?.balance).toBe(56);
  });

  test("get_user_details refuses a different user id", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await getUserDetails.execute({ user_id: "aarav_anderson_8794" }, ctx);
    expect(isError(result)).toBe(true);
  });

  test("get_order_details resolves shorthand and sets focus", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = (await getOrderDetails.execute({ order_id: "the delivered one" }, ctx)) as
      | OrderDetailsResult
      | ErrorResult;
    if (isError(result)) throw new Error(result.error);
    expect(result.order_id).toBe("#W5866402");
    expect(getState(ctx).focus.orderId).toBe("#W5866402");
  });

  test("get_order_details refuses another customer's order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await getOrderDetails.execute({ order_id: "#W4316152" }, ctx);
    expect(isError(result)).toBe(true);
  });

  test("get_product_details lists variants and needs no authentication", async () => {
    const result = (await getProductDetails.execute({ product_id: "9832717871" }, makeCtx())) as
      | ProductDetailsResult
      | ErrorResult;
    if (isError(result)) throw new Error(result.error);
    expect(result.name).toBe("Tea Kettle");
    expect(result.variants.length).toBeGreaterThan(1);
    expect(result.variants[0]).toHaveProperty("item_id");
  });

  test("get_product_details rejects an item id passed as a product id, and says so", async () => {
    const result = await getProductDetails.execute({ product_id: "3909406921" }, makeCtx());
    expect(isError(result) && result.error).toContain("item id");
  });

  test("get_item_details resolves an item without knowing its product", async () => {
    const result = (await getItemDetails.execute({ item_id: "3909406921" }, makeCtx())) as
      | ItemDetailsResult
      | ErrorResult;
    if (isError(result)) throw new Error(result.error);
    expect(result.price).toBe(98.25);
    expect(result.product_name).toBe("Tea Kettle");
  });

  test("list_all_product_types returns all 50, sorted by name", async () => {
    const result = (await listAllProductTypes.execute({}, makeCtx())) as
      | ProductTypesResult
      | ErrorResult;
    if (isError(result)) throw new Error(result.error);
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
    const result = (await cancelPendingOrder.execute(
      { order_id: "#W9300146", reason: "ordered by mistake" },
      ctx,
    )) as CancelOrderResult | ErrorResult;
    if (isError(result)) throw new Error(result.error);
    expect(result.status).toBe("cancelled");
    expect(result.refund_immediate).toBe(true);

    const state = getState(ctx);
    expect(state.store.orders["#W9300146"]?.status).toBe("cancelled");
    expect(state.store.orders["#W9300146"]?.cancel_reason).toBe("ordered by mistake");
    // $17.00 card + the $153.23 order total.
    const card = state.store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(170.23);
  });

  test("appends a matching refund to the payment history", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await cancelPendingOrder.execute({ order_id: "#W9300146", reason: "no longer needed" }, ctx);
    const history = getState(ctx).store.orders["#W9300146"]?.payment_history ?? [];
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      transaction_type: "refund",
      amount: 153.23,
      payment_method_id: "gift_card_7245904",
    });
  });

  test("a non-gift-card refund takes 5-7 days and moves no balance", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = (await cancelPendingOrder.execute(
      { order_id: "#W5442520", reason: "no longer needed" },
      ctx,
    )) as CancelOrderResult | ErrorResult;
    if (isError(result)) throw new Error(result.error);
    expect(result.refund_immediate).toBe(false);
    expect(result.message).toContain("5 to 7");
    const card = getState(ctx).store.users.olivia_ito_3591?.payment_methods.gift_card_7794233;
    expect(card?.source === "gift_card" && card.balance).toBe(56);
  });

  test("refuses a processed order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await cancelPendingOrder.execute(
      { order_id: "#W5353646", reason: "no longer needed" },
      ctx,
    );
    expect(isError(result) && result.error).toContain("processed");
    expect(getState(ctx).store.orders["#W5353646"]?.status).toBe("processed");
  });

  test("refuses a delivered order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await cancelPendingOrder.execute(
      { order_id: "#W5866402", reason: "no longer needed" },
      ctx,
    );
    expect(isError(result)).toBe(true);
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
    expect(isError(result) && result.error).toContain("no longer needed");
    expect(getState(ctx).store.orders["#W9300146"]?.status).toBe("pending");
  });

  test("refuses cancelling twice", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    await cancelPendingOrder.execute({ order_id: "#W9300146", reason: "no longer needed" }, ctx);
    const second = await cancelPendingOrder.execute(
      { order_id: "#W9300146", reason: "no longer needed" },
      ctx,
    );
    expect(isError(second)).toBe(true);
    const card = getState(ctx).store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(170.23);
  });

  test("resolves spoken shorthand to the single pending order", async () => {
    const ctx = await authedCtx("aarav.anderson9752@example.com");
    const result = (await cancelPendingOrder.execute(
      { order_id: "my pending order", reason: "ordered by mistake" },
      ctx,
    )) as CancelOrderResult | ErrorResult;
    expect(isError(result) ? null : result.order_id).toBe("#W9300146");
  });

  test("refuses ambiguous shorthand rather than cancelling the wrong order", async () => {
    const ctx = await authedCtx("olivia.ito5204@example.com");
    const result = await cancelPendingOrder.execute(
      { order_id: "my pending order", reason: "no longer needed" },
      ctx,
    );
    expect(isError(result)).toBe(true);
    const statuses = ["#W5442520", "#W7941031", "#W3657213"].map(
      (id) => getState(ctx).store.orders[id]?.status,
    );
    expect(statuses).toEqual(["pending", "pending", "pending"]);
  });
});
