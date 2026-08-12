import type { ToolContext, ToolDef } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";
import {
  calculateTotal,
  orderSlot,
  orderView,
  type Pizza,
  pizzaPrice,
  type StateSlot,
} from "./shared.ts";

// ─── Test doubles ────────────────────────────────────────────────────────────

/** Each context is one session — the cart is session-scoped by construction,
 *  and `createToolContext` mints a distinct session id per call. Its default
 *  `db` rejects every query, which is right here: this template keeps its cart
 *  in ctx.state and must never touch storage. */
function makeCtx(sessionId?: string) {
  const ctx = createToolContext<StateSlot>(sessionId ? { sessionId } : {});
  return { ctx, sent: ctx.sent };
}

function getTool(name: string): ToolDef {
  const def = agentDef.tools[name];
  if (!def) throw new Error(`tool ${name} not defined on agent`);
  return def;
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return await getTool(name).run(args, ctx);
}

const margherita: Omit<Pizza, "id"> = {
  size: "medium",
  crust: "regular",
  toppings: [],
  quantity: 1,
};

// ─── 1. Pure pricing ─────────────────────────────────────────────────────────

describe("pricing (shared.ts)", () => {
  test("base price + crust upcharge + toppings, times quantity", () => {
    const p: Pizza = {
      id: 1,
      size: "large", // 14.99
      crust: "stuffed", // +2.00
      toppings: ["pepperoni", "mushrooms"], // 1.50 + 1.00
      quantity: 2,
    };
    expect(pizzaPrice(p)).toBeCloseTo((14.99 + 2.0 + 1.5 + 1.0) * 2, 5);
  });

  test("cheese-only pizza costs base + crust", () => {
    expect(pizzaPrice({ id: 1, ...margherita })).toBeCloseTo(11.99, 5);
  });

  test("unknown topping falls back to the $1.00 default", () => {
    const known = pizzaPrice({ id: 1, ...margherita, toppings: ["onions"] }); // $1.00 topping
    const unknown = pizzaPrice({ id: 1, ...margherita, toppings: ["dragonfruit"] });
    expect(unknown).toBeCloseTo(known, 5);
  });

  test("calculateTotal sums all pizzas (empty order = 0)", () => {
    expect(calculateTotal([])).toBe(0);
    const a: Pizza = { id: 1, size: "small", crust: "thin", toppings: [], quantity: 1 };
    const b: Pizza = { id: 2, size: "small", crust: "thin", toppings: [], quantity: 3 };
    expect(calculateTotal([a, b])).toBeCloseTo(8.99 * 4, 5);
  });

  test("add_pizza schema defaults quantity to 1 and rejects non-positive quantities", async () => {
    const schema = getTool("add_pizza").input;
    if (!schema) throw new Error("add_pizza has no input schema");
    // Validate through the Standard Schema contract — the vendor-neutral
    // interface every input schema carries.
    const validate = (value: unknown) => schema["~standard"].validate(value);
    const ok = await validate({ size: "small", crust: "thin", toppings: [] });
    if (ok.issues) throw new Error("expected valid input");
    expect((ok.value as { quantity: number }).quantity).toBe(1);
    const zero = await validate({ size: "small", crust: "thin", toppings: [], quantity: 0 });
    expect(zero.issues).toBeDefined();
    const frac = await validate({ size: "small", crust: "thin", toppings: [], quantity: 1.5 });
    expect(frac.issues).toBeDefined();
  });
});

// ─── 2. Tool flow round-trip ─────────────────────────────────────────────────

describe("tool flow (add → update → remove → place_order)", () => {
  test("full ordering round-trip keeps state, totals, and IDs consistent", async () => {
    const { ctx } = makeCtx();

    // Empty order guards
    expect(await run("view_order", {}, ctx)).toEqual({ message: "The order is empty." });
    expect(await run("place_order", {}, ctx)).toEqual({ error: "Cannot place an empty order." });

    // Add two pizzas — IDs increment
    const first = (await run(
      "add_pizza",
      { size: "large", crust: "thin", toppings: ["pepperoni"], quantity: 1 },
      ctx,
    )) as { added: Pizza; orderTotal: string; itemCount: number };
    expect(first.added.id).toBe(1);
    expect(first.itemCount).toBe(1);
    expect(first.orderTotal).toBe(`$${(14.99 + 1.5).toFixed(2)}`);

    const second = (await run(
      "add_pizza",
      { size: "small", crust: "stuffed", toppings: [], quantity: 2 },
      ctx,
    )) as { added: Pizza; itemCount: number };
    expect(second.added.id).toBe(2);
    expect(second.itemCount).toBe(2);

    // Update only the provided fields
    const updated = (await run("update_pizza", { pizza_id: 2, quantity: 1 }, ctx)) as {
      updated: Pizza;
    };
    expect(updated.updated).toMatchObject({ id: 2, size: "small", crust: "stuffed", quantity: 1 });
    expect(await run("update_pizza", { pizza_id: 99, quantity: 1 }, ctx)).toEqual({
      error: "Pizza not found in the order.",
    });

    // Remove the first pizza
    const removed = (await run("remove_pizza", { pizza_id: 1 }, ctx)) as {
      removed: Pizza;
      itemCount: number;
    };
    expect(removed.removed.id).toBe(1);
    expect(removed.itemCount).toBe(1);
    expect(await run("remove_pizza", { pizza_id: 1 }, ctx)).toEqual({
      error: "Pizza not found in the order.",
    });

    // Name + place the order
    await run("set_customer_name", { name: "Alex" }, ctx);
    const placed = (await run("place_order", {}, ctx)) as {
      orderNumber: number;
      customerName: string;
      pizzas: number;
      total: string;
    };
    expect(placed.customerName).toBe("Alex");
    expect(placed.pizzas).toBe(1);
    expect(placed.total).toBe(`$${(8.99 + 2.0).toFixed(2)}`);

    // The cart is cleared after placing — a follow-up order starts fresh.
    expect(await run("view_order", {}, ctx)).toEqual({ message: "The order is empty." });
    expect(await run("place_order", {}, ctx)).toEqual({ error: "Cannot place an empty order." });
  });

  test("carts are scoped per session — two sessions never share pizzas or names", async () => {
    // ctx.state is per-session by construction — each session has its own.
    const { ctx: sessionA } = makeCtx("session-a");
    const { ctx: sessionB } = makeCtx("session-b");

    await run(
      "add_pizza",
      { size: "large", crust: "thin", toppings: ["bacon"], quantity: 1 },
      sessionA,
    );
    await run("set_customer_name", { name: "Alice" }, sessionA);

    expect(await run("view_order", {}, sessionB)).toEqual({ message: "The order is empty." });

    await run("add_pizza", { size: "small", crust: "thin", toppings: [], quantity: 1 }, sessionB);
    const placedB = (await run("place_order", {}, sessionB)) as {
      customerName: string;
      pizzas: number;
    };
    // Session B never sees session A's customer name or pizzas.
    expect(placedB.customerName).toBe("Guest");
    expect(placedB.pizzas).toBe(1);

    // Session A's cart survives session B's checkout untouched.
    const viewA = (await run("view_order", {}, sessionA)) as { pizzas: unknown[] };
    expect(viewA.pizzas).toHaveLength(1);
  });
});

// ─── 3. The projection contract with client.tsx ─────────────────────────────
//
// `syncState: orderView` is now the ONLY thing the sidebar reads, which makes
// the contract a pure function of state rather than an if/else chain over
// event shapes. What used to need six event-shape assertions is three.

describe("orderView projection", () => {
  test("reflects the live cart", async () => {
    const { ctx } = makeCtx();
    await run(
      "add_pizza",
      { size: "large", crust: "stuffed", toppings: ["pepperoni", "extra_cheese"], quantity: 2 },
      ctx,
    );

    const view = orderView(orderSlot.read(ctx.state));
    expect(view.orderPlaced).toBe(false);
    const item = view.pizzas[0];
    if (!item) throw new Error("no pizza in the projection");
    // The client renders these fields directly and calls pizzaPrice on them.
    expect(item).toMatchObject({
      id: 1,
      size: "large",
      crust: "stuffed",
      toppings: ["pepperoni", "extra_cheese"],
      quantity: 2,
    });
    expect(view.total).toBe(`$${pizzaPrice(item).toFixed(2)}`);
  });

  test("survives checkout, which clears the cart but keeps the confirmation", async () => {
    // The reason `placed` lives in state at all: the cart is emptied on
    // checkout, and the UI still has to show the order that was just placed.
    const { ctx } = makeCtx();
    await run("add_pizza", { size: "small", crust: "thin", toppings: [], quantity: 1 }, ctx);
    await run("place_order", {}, ctx);

    const view = orderView(orderSlot.read(ctx.state));
    expect(view.orderPlaced).toBe(true);
    expect(view.pizzas).toEqual([]);
    expect(view.estimatedMinutes).toBe(20);
    expect(view.total).toMatch(/^\$\d+\.\d{2}$/);
  });

  test("an untouched session projects an empty cart, not undefined", () => {
    // The client renders before any tool has run, so `state.order` is absent —
    // this is exactly the value `client.tsx` hoists as its fallback.
    expect(orderSlot.projection(orderView)(undefined)).toMatchObject({
      pizzas: [],
      total: "$0.00",
      orderPlaced: false,
    });
  });
});
