import { describe, expect, test } from "vitest";
import { z } from "zod";
import seedJson from "./seed.json";

const AddressSchema = z.object({
  address1: z.string(),
  address2: z.string(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  zip: z.string(),
});

const PaymentMethodSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("gift_card"), id: z.string(), balance: z.number() }),
  z.object({ source: z.literal("paypal"), id: z.string() }),
  z.object({
    source: z.literal("credit_card"),
    id: z.string(),
    brand: z.string(),
    last_four: z.string(),
  }),
]);

const VariantSchema = z.object({
  item_id: z.string(),
  options: z.record(z.string(), z.string()),
  available: z.boolean(),
  price: z.number(),
});

const SeedSchema = z.object({
  products: z.record(
    z.string(),
    z.object({
      name: z.string(),
      product_id: z.string(),
      variants: z.record(z.string(), VariantSchema),
    }),
  ),
  users: z.record(
    z.string(),
    z.object({
      user_id: z.string(),
      name: z.object({ first_name: z.string(), last_name: z.string() }),
      address: AddressSchema,
      email: z.string(),
      payment_methods: z.record(z.string(), PaymentMethodSchema),
      orders: z.array(z.string()),
    }),
  ),
  orders: z.record(
    z.string(),
    z.object({
      order_id: z.string(),
      user_id: z.string(),
      address: AddressSchema,
      items: z.array(
        z.object({
          name: z.string(),
          product_id: z.string(),
          item_id: z.string(),
          price: z.number(),
          options: z.record(z.string(), z.string()),
        }),
      ),
      status: z.string(),
      fulfillments: z
        .array(z.object({ tracking_id: z.array(z.string()), item_ids: z.array(z.string()) }))
        .optional(),
      payment_history: z.array(
        z.object({
          transaction_type: z.enum(["payment", "refund"]),
          amount: z.number(),
          payment_method_id: z.string(),
        }),
      ),
    }),
  ),
});

// Parsed ONCE here so `store.ts` can cast at zero runtime cost. This test is
// what makes that cast honest.
const seed = SeedSchema.parse(seedJson);

describe("seed shape", () => {
  test("matches the tau2 schema", () => {
    expect(Object.keys(seed.products)).toHaveLength(50);
    expect(Object.keys(seed.users)).toHaveLength(6);
    expect(Object.keys(seed.orders)).toHaveLength(22);
  });

  // These four sweep the whole corpus, so they assert SOFTLY: one hand-edited
  // order usually breaks several records at once, and a hard failure reports
  // the first and hides how far the damage runs.
  test("every order belongs to a seeded user and is listed on that user", () => {
    for (const order of Object.values(seed.orders)) {
      const user = seed.users[order.user_id];
      expect.soft(user, `order ${order.order_id} has no seeded user`).toBeDefined();
      expect
        .soft(user?.orders ?? [], `${order.order_id} is not listed on its user`)
        .toContain(order.order_id);
    }
  });

  test("every user's listed orders are all seeded", () => {
    for (const user of Object.values(seed.users)) {
      for (const orderId of user.orders) {
        expect
          .soft(seed.orders[orderId], `${user.user_id} lists unseeded ${orderId}`)
          .toBeDefined();
      }
    }
  });

  test("every ordered item resolves to a product variant with a matching price", () => {
    for (const order of Object.values(seed.orders)) {
      for (const item of order.items) {
        const variant = seed.products[item.product_id]?.variants[item.item_id];
        expect
          .soft(variant, `${order.order_id}: ${item.item_id} missing from its product`)
          .toBeDefined();
        expect.soft(variant?.price, `${order.order_id}: ${item.item_id} price`).toBe(item.price);
      }
    }
  });

  test("every payment_method_id in an order resolves on its user", () => {
    for (const order of Object.values(seed.orders)) {
      const user = seed.users[order.user_id];
      for (const payment of order.payment_history) {
        expect
          .soft(
            user?.payment_methods[payment.payment_method_id],
            `${order.order_id}: unknown method ${payment.payment_method_id}`,
          )
          .toBeDefined();
      }
    }
  });

  test("names + zips are unique, so find_user_id_by_name_zip is unambiguous", () => {
    const keys = Object.values(seed.users).map((u) =>
      `${u.name.first_name}|${u.name.last_name}|${u.address.zip}`.toLowerCase(),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("emails are unique", () => {
    const emails = Object.values(seed.users).map((u) => u.email.toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
  });
});

describe("seed coverage — each datum backs a specific test in agent.test.ts", () => {
  test("every status the tools branch on is present", () => {
    const statuses = new Set(Object.values(seed.orders).map((o) => o.status));
    for (const s of ["pending", "processed", "delivered", "cancelled"]) {
      expect.soft(statuses, `no ${s} order seeded`).toContain(s);
    }
  });

  test("aarav_anderson has one gift card at $17.00 and no other method", () => {
    const methods = seed.users.aarav_anderson_8794?.payment_methods ?? {};
    expect(Object.keys(methods)).toEqual(["gift_card_7245904"]);
    expect(methods.gift_card_7245904).toMatchObject({ source: "gift_card", balance: 17 });
  });

  test("harper_brown holds no gift card, so a return must go to the original method", () => {
    const methods = Object.values(seed.users.harper_brown_7363?.payment_methods ?? {});
    expect(methods.some((m) => m.source === "gift_card")).toBe(false);
    expect(methods.length).toBeGreaterThanOrEqual(2);
  });

  test("olivia_ito holds all three payment-method kinds", () => {
    const sources = Object.values(seed.users.olivia_ito_3591?.payment_methods ?? {})
      .map((m) => m.source)
      .sort();
    expect(sources).toEqual(["credit_card", "gift_card", "paypal"]);
  });

  test("olivia_ito has three pending orders, so ordinal shorthand must disambiguate", () => {
    const pending = (seed.users.olivia_ito_3591?.orders ?? []).filter(
      (id) => seed.orders[id]?.status === "pending",
    );
    expect(pending).toHaveLength(3);
  });

  test("#W4316152 carries a duplicate item id", () => {
    const items = seed.orders["#W4316152"]?.items.map((i) => i.item_id) ?? [];
    expect(items).toEqual(["7292993796", "7292993796"]);
  });

  test("#W1840144 carries a duplicate item id on a non-gift-card order", () => {
    const order = seed.orders["#W1840144"];
    const dupes = (order?.items ?? []).filter((i) => i.item_id === "8590708195");
    expect(dupes).toHaveLength(2);
    expect(order?.payment_history[0]?.payment_method_id).toBe("paypal_2306935");
  });

  test("the exchange arithmetic every test asserts is reachable", () => {
    const cases: [string, string, string, number][] = [
      // product_id, from item, to item, expected diff
      ["1762337868", "1304426904", "4725166838", 36.32], // exceeds aarav's $17
      ["9832717871", "7292993796", "3909406921", 3.45], // fits
      ["4354588079", "6242772310", "6200867091", -40.86], // refund direction
      ["4760268021", "8997785118", "6017636844", -382.03], // pending modify refund
      ["4760268021", "6017636844", "9844888101", 167.37], // exceeds anya's $51 card
    ];
    for (const [productId, from, to, diff] of cases) {
      const variants = seed.products[productId]?.variants;
      const a = variants?.[from];
      const b = variants?.[to];
      expect(a, `${productId}: ${from} trimmed away`).toBeDefined();
      expect(b, `${productId}: ${to} trimmed away`).toBeDefined();
      expect(b?.available, `${to} must be available to be an exchange target`).toBe(true);
      expect(Math.round(((b?.price ?? 0) - (a?.price ?? 0)) * 100) / 100).toBe(diff);
    }
  });

  test("an unavailable variant survives trimming for the 'not available' path", () => {
    expect(seed.products["9832717871"]?.variants["6454334990"]?.available).toBe(false);
  });

  test("every product keeps at least two variants, so an exchange always has a target", () => {
    for (const [pid, product] of Object.entries(seed.products)) {
      expect(Object.keys(product.variants).length, `${pid} has too few variants`).toBeGreaterThan(
        1,
      );
    }
  });
});
