/// <reference types="vite/client" />

import type { ToolContext } from "@alexkroman1/aai";
import {
  createToolContext,
  parseToolInput,
  toolInputIssues,
  toolRunner,
  withDiscoveredTools,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS: it is what a scaffolded project runs, so it may not import
 * anything outside its own template, and `import.meta.glob` is expanded against
 * the file containing it either way. This is the pattern a user writes.
 */
const agentDef = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);

import {
  calculateTotal,
  MENU,
  orderProjection,
  orderSlot,
  orderView,
  type Pizza,
  pizzaPrice,
} from "./shared.ts";

// ─── Test doubles ────────────────────────────────────────────────────────────

/** Each context owns its OWN slot store, so two contexts are two carts. Its
 *  default `db` rejects every query, which is right here: this template keeps
 *  its cart in a session slot and must never touch storage. */
const makeCtx = (): ToolContext => createToolContext();

/** A tool by the name the model calls it by, bound to this agent. The lookup,
 *  its "no such tool" message and the args-or-context shape are all
 *  `toolRunner`'s (`@alexkroman1/aai/testing`); what is local is only which
 *  agent it runs against. Its second parameter is args-or-context, so a
 *  no-argument tool passes the context in the arguments' place. */
const run = toolRunner(agentDef);

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

  test("a topping named the way the MENU PROSE spells it is charged menu price", () => {
    // `menuText()` writes `extra_cheese` as "extra cheese", so that is what a
    // model reading the prompt asks for. Before `toppingKey`, the table missed
    // and charged the $1.00 unknown-topping default for a $1.50 topping —
    // found live by `agent.eval.test.ts`, which priced the same pizza off MENU
    // and got $17.99 against the tool's $17.49.
    const keyed = pizzaPrice({ id: 1, ...margherita, toppings: ["extra_cheese"] });
    expect(pizzaPrice({ id: 1, ...margherita, toppings: ["extra cheese"] })).toBeCloseTo(keyed, 5);
    expect(pizzaPrice({ id: 1, ...margherita, toppings: ["Green Peppers"] })).toBeCloseTo(
      11.99 + MENU.toppings.green_peppers,
      5,
    );
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
    const base = { size: "small", crust: "thin", toppings: [] };
    const parsed = await parseToolInput<{ quantity: number }>(agentDef, "add_pizza", base);
    expect(parsed.quantity).toBe(1);
    expect(await toolInputIssues(agentDef, "add_pizza", { ...base, quantity: 0 })).toBeDefined();
    expect(await toolInputIssues(agentDef, "add_pizza", { ...base, quantity: 1.5 })).toBeDefined();
  });
});

// ─── 2. Tool flow round-trip ─────────────────────────────────────────────────

describe("tool flow (add → update → remove → place_order)", () => {
  test("full ordering round-trip keeps state, totals, and IDs consistent", async () => {
    const ctx = makeCtx();

    // Empty order guards
    expect(await run("view_order", ctx)).toEqual({ message: "The order is empty." });
    expect(await run("place_order", ctx)).toEqual({ error: "Cannot place an empty order." });

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
    const placed = (await run("place_order", ctx)) as {
      orderNumber: number;
      customerName: string;
      pizzas: number;
      total: string;
    };
    expect(placed.customerName).toBe("Alex");
    expect(placed.pizzas).toBe(1);
    expect(placed.total).toBe(`$${(8.99 + 2.0).toFixed(2)}`);

    // The cart is cleared after placing — a follow-up order starts fresh.
    expect(await run("view_order", ctx)).toEqual({ message: "The order is empty." });
    expect(await run("place_order", ctx)).toEqual({ error: "Cannot place an empty order." });
  });

  test("two independent contexts never share pizzas or names", async () => {
    // What this really checks, and it is worth checking: the cart lives in the
    // SLOT and not in a module-level variable. `createToolContext()` hands each
    // call its own detached slot store, so passing two distinct session ids
    // would prove nothing extra — the isolation is per store, and the store is
    // per context. A template that cached its order in a module would fail here.
    const firstCall = makeCtx();
    const secondCall = makeCtx();

    await run(
      "add_pizza",
      { size: "large", crust: "thin", toppings: ["bacon"], quantity: 1 },
      firstCall,
    );
    await run("set_customer_name", { name: "Alice" }, firstCall);

    expect(await run("view_order", secondCall)).toEqual({ message: "The order is empty." });

    await run("add_pizza", { size: "small", crust: "thin", toppings: [], quantity: 1 }, secondCall);
    const placedB = (await run("place_order", secondCall)) as {
      customerName: string;
      pizzas: number;
    };
    // The second context never sees the first's customer name or pizzas.
    expect(placedB.customerName).toBe("Guest");
    expect(placedB.pizzas).toBe(1);

    // And the first context's cart survives the second's checkout untouched.
    const viewA = (await run("view_order", firstCall)) as { pizzas: unknown[] };
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
    const ctx = makeCtx();
    await run(
      "add_pizza",
      { size: "large", crust: "stuffed", toppings: ["pepperoni", "extra_cheese"], quantity: 2 },
      ctx,
    );

    const view = orderView(orderSlot.get(ctx));
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
    const ctx = makeCtx();
    await run("add_pizza", { size: "small", crust: "thin", toppings: [], quantity: 1 }, ctx);
    await run("place_order", ctx);

    const view = orderView(orderSlot.get(ctx));
    expect(view.orderPlaced).toBe(true);
    expect(view.pizzas).toEqual([]);
    expect(view.estimatedMinutes).toBe(20);
    expect(view.total).toMatch(/^\$\d+\.\d{2}$/);
  });

  test("an untouched session projects an empty cart, not undefined", () => {
    // The client renders before any tool has run, so `state.order` is absent —
    // this is exactly the frame `client.tsx` gets from the same projection.
    expect(orderProjection()).toMatchObject({
      pizzas: [],
      total: "$0.00",
      orderPlaced: false,
    });
  });
});
