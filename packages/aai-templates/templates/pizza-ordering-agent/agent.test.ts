import agentDef from "virtual:aai/agent";
import { createSeededRandom, type InferToolInput } from "@alexkroman1/aai";
import { instructionOf, stripInstruction } from "@alexkroman1/aai/utils";
import {
  createToolContext,
  expectSlotContract,
  expectToolOk,
  parseToolInput,
  toolInputIssues,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";
import { calculateTotal, cartSummary, MENU, orderSlot, type Pizza, pizzaPrice } from "./shared.ts";
// The tool FILES: a file's default export is the very object `agentDef`
// registers under its name, and handing it to `run` is what types the call's
// arguments and its result.
import addPizza from "./tools/add_pizza.ts";
import placeOrder from "./tools/place_order.ts";
import removePizza from "./tools/remove_pizza.ts";
import setCustomerName from "./tools/set_customer_name.ts";
import updatePizza from "./tools/update_pizza.ts";
import viewOrder from "./tools/view_order.ts";

// ─── Test doubles ────────────────────────────────────────────────────────────

/**
 * A customer, with a random source a spec can predict.
 *
 * `place_order` mints its confirmation number through `ctx.random`, which is
 * the whole reason it does not reach for `Math.random` — `createSeededRandom`
 * makes that promise pay, and the number below is an assertion rather than a
 * `toMatch(/\d{4}/)`.
 */
const customer = (seed = 20_260_308) => createToolContext({ random: createSeededRandom(seed) });

/** What `customer()`'s default seed mints on its first draw. */
const SEEDED_ORDER_NUMBER = 7641;

const margherita: Omit<Pizza, "id"> = {
  size: "medium",
  crust: "regular",
  toppings: [],
  quantity: 1,
};

describeAgent(agentDef, (run) => {
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
      // `toBe`, not `toBeCloseTo`: `roundMoney` snaps every line to whole cents,
      // so the value the sidebar prints and the value a total sums are the same
      // number. Un-rounded, this product is 38.980000000000004 — which prints as
      // `$38.98` and compares as something else.
      expect(pizzaPrice(p)).toBe(38.98);
    });

    test("cheese-only pizza costs base + crust", () => {
      expect(pizzaPrice({ id: 1, ...margherita })).toBe(11.99);
    });

    test("a topping named the way the MENU PROSE spells it is charged menu price", () => {
      // `menuText()` writes `extra_cheese` as "extra cheese", so that is what a
      // model reading the prompt asks for. Before `toppingKey`, the table missed
      // and charged the $1.00 unknown-topping default for a $1.50 topping —
      // found live by `agent.eval.test.ts`, which priced the same pizza off MENU
      // and got $17.99 against the tool's $17.49.
      const keyed = pizzaPrice({ id: 1, ...margherita, toppings: ["extra_cheese"] });
      expect(pizzaPrice({ id: 1, ...margherita, toppings: ["extra cheese"] })).toBe(keyed);
      expect(pizzaPrice({ id: 1, ...margherita, toppings: ["Green Peppers"] })).toBe(
        11.99 + MENU.toppings.green_peppers,
      );
    });

    test("unknown topping falls back to the $1.00 default", () => {
      const known = pizzaPrice({ id: 1, ...margherita, toppings: ["onions"] }); // $1.00 topping
      const unknown = pizzaPrice({ id: 1, ...margherita, toppings: ["dragonfruit"] });
      expect(unknown).toBe(known);
    });

    test("calculateTotal sums all pizzas (empty order = 0)", () => {
      expect(calculateTotal([])).toBe(0);
      const a: Pizza = { id: 1, size: "small", crust: "thin", toppings: [], quantity: 1 };
      const b: Pizza = { id: 2, size: "small", crust: "thin", toppings: [], quantity: 3 };
      expect(calculateTotal([a, b])).toBe(35.96);
      // And the summary the four tools report is that total, formatted once.
      expect(cartSummary([a, b])).toEqual({ orderTotal: "$35.96", itemCount: 2 });
      expect(cartSummary([])).toEqual({ orderTotal: "$0.00", itemCount: 0 });
    });

    test("add_pizza schema defaults quantity to 1 and rejects non-positive quantities", async () => {
      const base = { size: "small", crust: "thin", toppings: [] };
      // The tool's OWN parsed-argument type, so a schema that stopped defaulting
      // `quantity` — or dropped it — fails here at compile time.
      const parsed = await parseToolInput<InferToolInput<typeof addPizza>>(
        agentDef,
        "add_pizza",
        base,
      );
      expect(parsed.quantity).toBe(1);
      expect(await toolInputIssues(agentDef, "add_pizza", { ...base, quantity: 0 })).toBeDefined();
      expect(
        await toolInputIssues(agentDef, "add_pizza", { ...base, quantity: 1.5 }),
      ).toBeDefined();
    });
  });

  // ─── 2. Tool flow round-trip ─────────────────────────────────────────────────

  describe("tool flow (add → update → remove → place_order)", () => {
    test("full ordering round-trip keeps state, totals, and IDs consistent", async () => {
      const ctx = customer();

      // Empty order guards: the model is told what to do, and nothing is placed.
      const empty = await run(viewOrder, ctx);
      // The data alone is the summary; the instruction rides beside it.
      expect(stripInstruction(empty)).toEqual({ pizzas: [], orderTotal: "$0.00", itemCount: 0 });
      expect(instructionOf(empty)).toContain("empty");
      expect(await run(placeOrder, ctx)).toEqual({ error: "Cannot place an empty order." });

      // Add two pizzas — IDs increment
      const first = await run(
        addPizza,
        { size: "large", crust: "thin", toppings: ["pepperoni"], quantity: 1 },
        ctx,
      );
      expect(first.added.id).toBe(1);
      expect(first.itemCount).toBe(1);
      expect(first.orderTotal).toBe("$16.49");

      const second = await run(
        addPizza,
        { size: "small", crust: "stuffed", toppings: [], quantity: 2 },
        ctx,
      );
      expect(second.added.id).toBe(2);
      expect(second.itemCount).toBe(2);

      // Update only the provided fields. Each mutating tool answers
      // `… | ToolFailure`, so the spec narrows the way a forwarding caller does.
      const updated = expectToolOk(await run(updatePizza, { pizza_id: 2, quantity: 1 }, ctx));
      expect(updated.updated).toMatchObject({
        id: 2,
        size: "small",
        crust: "stuffed",
        quantity: 1,
      });
      expect(await run(updatePizza, { pizza_id: 99, quantity: 1 }, ctx)).toEqual({
        error: "Pizza not found in the order.",
      });

      // Remove the first pizza
      const removed = expectToolOk(await run(removePizza, { pizza_id: 1 }, ctx));
      expect(removed.removed.id).toBe(1);
      expect(removed.itemCount).toBe(1);
      expect(await run(removePizza, { pizza_id: 1 }, ctx)).toEqual({
        error: "Pizza not found in the order.",
      });

      // Name + place the order
      await run(setCustomerName, { name: "Alex" }, ctx);
      const placed = expectToolOk(await run(placeOrder, ctx));
      expect(placed.customerName).toBe("Alex");
      expect(placed.pizzas).toBe(1);
      expect(placed.total).toBe("$10.99");
      // The confirmation number is `ctx.random`'s, and this context's source is
      // seeded — so this is the claim `place_order`'s comment makes, checked.
      expect(placed.orderNumber).toBe(SEEDED_ORDER_NUMBER);

      // The cart is cleared after placing — a follow-up order starts fresh.
      expect(await run(viewOrder, ctx)).toMatchObject({ pizzas: [] });
      expect(await run(placeOrder, ctx)).toEqual({ error: "Cannot place an empty order." });
    });

    test("the same seed mints the same confirmation number, a different one does not", async () => {
      // What `ctx.random` buys: two sessions are independent draws, and a spec
      // that wants one of them can have it. A `place_order` reaching for
      // `Math.random` passes neither half of this.
      const place = async (seed?: number) => {
        const ctx = customer(seed);
        await run(addPizza, { size: "small", crust: "thin", toppings: [], quantity: 1 }, ctx);
        return expectToolOk(await run(placeOrder, ctx)).orderNumber;
      };

      expect(await place()).toBe(SEEDED_ORDER_NUMBER);
      expect(await place()).toBe(SEEDED_ORDER_NUMBER);

      const other = await place(1);
      expect(other).not.toBe(SEEDED_ORDER_NUMBER);
      // Four digits, whatever the seed.
      expect(other).toBeGreaterThanOrEqual(1000);
      expect(other).toBeLessThan(10_000);
    });

    test("the cart lives in the slot: sessions are isolated and the projection is the default's", () => {
      // A template that cached its order in a module variable would fail here.
      expectSlotContract(orderSlot, {
        write: (order) => {
          order.customerName = "Alice";
        },
      });
    });
  });

  // ─── 3. The projection contract with client.tsx ─────────────────────────────
  //
  // `syncState: orderSlot.projected` is the ONLY thing the sidebar reads, which makes
  // the contract a pure function of state rather than an if/else chain over
  // event shapes. What used to need six event-shape assertions is three.

  describe("the order projection", () => {
    test("reflects the live cart", async () => {
      const ctx = createToolContext();
      await run(
        addPizza,
        { size: "large", crust: "stuffed", toppings: ["pepperoni", "extra_cheese"], quantity: 2 },
        ctx,
      );

      const view = orderSlot.projected(orderSlot.get(ctx));
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
      const ctx = createToolContext();
      await run(addPizza, { size: "small", crust: "thin", toppings: [], quantity: 1 }, ctx);
      await run(placeOrder, ctx);

      const view = orderSlot.projected(orderSlot.get(ctx));
      expect(view.orderPlaced).toBe(true);
      expect(view.pizzas).toEqual([]);
      expect(view.estimatedMinutes).toBe(20);
      expect(view.total).toMatch(/^\$\d+\.\d{2}$/);
    });

    test("an untouched session projects an empty cart, not undefined", () => {
      // The client renders before any tool has run, so `state.order` is absent —
      // this is exactly the frame `client.tsx` gets from the same projection.
      expect(orderSlot.projected()).toMatchObject({
        pizzas: [],
        total: "$0.00",
        orderPlaced: false,
      });
    });
  });
});
