import type { Db, ToolContext, ToolDef } from "@alexkroman1/aai";
import type { Vector } from "@alexkroman1/aai/vector";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";
import { calculateTotal, type Pizza, pizzaPrice } from "./shared.ts";

// ─── Test doubles ────────────────────────────────────────────────────────────

/** This template keeps its cart in ctx.state — the db must never be touched. */
const noDb: Db = {
  query: () => Promise.reject(new Error("db not used by this template")),
};

const noopVector: Vector = {
  async upsert() {},
  async query() {
    return [];
  },
  async delete() {},
};

/** ToolContext stub: per-session ctx.state, and captured ctx.send events.
 *  Each stub is one session — the cart is session-scoped by construction. */
function makeCtx(sessionId = "session-a") {
  const sent: Array<{ event: string; data: unknown }> = [];
  const ctx: ToolContext = {
    env: {},
    state: {},
    db: noDb,
    vector: noopVector,
    generate: () => Promise.reject(new Error("generate not available in tests")),
    messages: [],
    sessionId,
    send: (event, data) => {
      sent.push({ event, data });
    },
  };
  return { ctx, sent };
}

function getTool(name: string): ToolDef {
  const def = agentDef.tools[name];
  if (!def) throw new Error(`tool ${name} not defined on agent`);
  return def;
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return await getTool(name).execute(args, ctx);
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

  test("add_pizza schema defaults quantity to 1 and rejects non-positive quantities", () => {
    const schema = getTool("add_pizza").parameters;
    if (!schema) throw new Error("add_pizza has no parameters schema");
    const parsed = schema.parse({ size: "small", crust: "thin", toppings: [] });
    expect(parsed.quantity).toBe(1);
    expect(() =>
      schema.parse({ size: "small", crust: "thin", toppings: [], quantity: 0 }),
    ).toThrow();
    expect(() =>
      schema.parse({ size: "small", crust: "thin", toppings: [], quantity: 1.5 }),
    ).toThrow();
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

// ─── 3. Wire-shape contract with client.tsx ──────────────────────────────────
//
// The sidebar (client.tsx) discriminates "order" events by key shape in an
// if/else chain: added → removed → updated → array-pizzas → orderNumber.
// Pin each payload to exactly one branch so agent and client can't drift.

function matchedBranch(data: Record<string, unknown>): string {
  if ("added" in data && data.added) return "added";
  if ("removed" in data && data.removed) return "removed";
  if ("updated" in data && data.updated) return "updated";
  if ("pizzas" in data && Array.isArray(data.pizzas)) return "view";
  if ("orderNumber" in data && data.orderNumber) return "placed";
  return "none";
}

describe('"order" event contract', () => {
  test("each mutating tool emits exactly one event, matching its client branch", async () => {
    const { ctx, sent } = makeCtx();

    await run(
      "add_pizza",
      { size: "medium", crust: "regular", toppings: ["ham"], quantity: 1 },
      ctx,
    );
    await run("add_pizza", { size: "small", crust: "thin", toppings: [], quantity: 1 }, ctx);
    await run("update_pizza", { pizza_id: 1, toppings: ["chicken"] }, ctx);
    await run("view_order", {}, ctx);
    await run("remove_pizza", { pizza_id: 2 }, ctx);
    await run("place_order", {}, ctx);

    expect(sent.every((s) => s.event === "order")).toBe(true);
    const branches = sent.map((s) => matchedBranch(s.data as Record<string, unknown>));
    expect(branches).toEqual(["added", "added", "updated", "view", "removed", "placed"]);
  });

  test("place_order's `pizzas` is a count, not an array — it must not hit the view branch", async () => {
    const { ctx, sent } = makeCtx();
    await run("add_pizza", { size: "small", crust: "thin", toppings: [], quantity: 1 }, ctx);
    await run("place_order", {}, ctx);

    const last = sent.at(-1);
    if (!last) throw new Error("no event captured");
    const placed = last.data as Record<string, unknown>;
    expect(typeof placed.pizzas).toBe("number");
    expect(matchedBranch(placed)).toBe("placed");
    expect(placed).toMatchObject({
      customerName: "Guest",
      total: expect.stringMatching(/^\$\d+\.\d{2}$/),
      estimatedMinutes: 20,
    });
  });

  test("view_order items carry every field the sidebar renders", async () => {
    const { ctx, sent } = makeCtx();
    await run(
      "add_pizza",
      { size: "large", crust: "stuffed", toppings: ["pepperoni", "extra_cheese"], quantity: 2 },
      ctx,
    );
    await run("view_order", {}, ctx);

    const last = sent.at(-1);
    if (!last) throw new Error("no event captured");
    const view = last.data as { pizzas: Pizza[]; orderTotal: string };
    expect(Array.isArray(view.pizzas)).toBe(true);
    const item = view.pizzas[0];
    if (!item) throw new Error("no pizza in view payload");
    // The client casts these items to Pizza and calls pizzaPrice on them.
    expect(item).toMatchObject({
      id: 1,
      size: "large",
      crust: "stuffed",
      toppings: ["pepperoni", "extra_cheese"],
      quantity: 2,
    });
    expect(view.orderTotal).toBe(`$${pizzaPrice(item).toFixed(2)}`);
  });
});
