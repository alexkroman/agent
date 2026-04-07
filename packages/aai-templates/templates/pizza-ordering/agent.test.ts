import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Pizza Palace", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Pizza Palace");
  });

  test("has all pizza tools", () => {
    expect(Object.keys(agent.tools!)).toEqual(
      expect.arrayContaining([
        "add_pizza",
        "remove_pizza",
        "update_pizza",
        "view_order",
        "set_customer_name",
        "place_order",
      ]),
    );
  });

  test("add a pizza and view order", async () => {
    const t = createTestHarness(agent);

    const addTurn = await t.turn("I want a large pepperoni pizza", [
      {
        tool: "add_pizza",
        args: { size: "large", crust: "regular", toppings: ["pepperoni"], quantity: 1 },
      },
    ]);
    expect(addTurn).toHaveCalledTool("add_pizza", { size: "large" });
    const added = addTurn.toolResult("add_pizza");
    expect(added.added.size).toBe("large");
    expect(added.itemCount).toBe(1);

    const viewTurn = await t.turn("Show me my order", [{ tool: "view_order", args: {} }]);
    expect(viewTurn).toHaveCalledTool("view_order");
    const order = viewTurn.toolResult("view_order");
    expect(order.pizzas).toHaveLength(1);
  });

  test("remove a pizza from order", async () => {
    const t = createTestHarness(agent);

    await t.turn("Add a pizza", [
      { tool: "add_pizza", args: { size: "small", crust: "thin", toppings: [], quantity: 1 } },
    ]);

    const removeTurn = await t.turn("Remove that pizza", [
      { tool: "remove_pizza", args: { pizza_id: 1 } },
    ]);
    expect(removeTurn).toHaveCalledTool("remove_pizza");
    const result = removeTurn.toolResult("remove_pizza");
    expect(result.itemCount).toBe(0);
  });

  test("update pizza toppings", async () => {
    const t = createTestHarness(agent);

    await t.turn("Add a pizza", [
      {
        tool: "add_pizza",
        args: { size: "medium", crust: "regular", toppings: ["cheese"], quantity: 1 },
      },
    ]);

    const updateTurn = await t.turn("Add pepperoni to that", [
      { tool: "update_pizza", args: { pizza_id: 1, toppings: ["cheese", "pepperoni"] } },
    ]);
    const updated = updateTurn.toolResult("update_pizza");
    expect(updated.updated.toppings).toContain("pepperoni");
  });

  test("cannot place empty order", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Place my order", [{ tool: "place_order", args: {} }]);
    const result = turn.toolResult("place_order");
    expect(result.error).toBe("Cannot place an empty order.");
  });

  test("full ordering flow", async () => {
    const t = createTestHarness(agent);

    await t.turn("I'm Alex", [{ tool: "set_customer_name", args: { name: "Alex" } }]);

    await t.turn("Large pepperoni with extra cheese", [
      {
        tool: "add_pizza",
        args: {
          size: "large",
          crust: "regular",
          toppings: ["pepperoni", "extra_cheese"],
          quantity: 1,
        },
      },
    ]);

    await t.turn("And a small margherita", [
      { tool: "add_pizza", args: { size: "small", crust: "thin", toppings: [], quantity: 1 } },
    ]);

    const placeTurn = await t.turn("That's it, place the order", [
      { tool: "place_order", args: {} },
    ]);
    const order = placeTurn.toolResult("place_order");
    expect(order.orderNumber).toBeDefined();
    expect(order.customerName).toBe("Alex");
    expect(order.pizzas).toBe(2);
  });
});
