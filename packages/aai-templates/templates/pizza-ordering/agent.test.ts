import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai-cli/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Pizza Palace", () => {
  test("add a pizza and view order", async () => {
    const t = await createTestHarness(join(__dirname));

    const addTurn = await t.turn("I want a large pepperoni pizza", [
      {
        tool: "add_pizza",
        args: { size: "large", crust: "regular", toppings: ["pepperoni"], quantity: 1 },
      },
    ]);
    const added = addTurn.toolResult<{ added: { size: string }; itemCount: number }>("add_pizza");
    expect(added.added.size).toBe("large");
    expect(added.itemCount).toBe(1);

    const viewTurn = await t.turn("Show me my order", [{ tool: "view_order", args: {} }]);
    const order = viewTurn.toolResult<{ pizzas: unknown[] }>("view_order");
    expect(order.pizzas).toHaveLength(1);
  });

  test("remove a pizza from order", async () => {
    const t = await createTestHarness(join(__dirname));

    await t.turn("Add a pizza", [
      { tool: "add_pizza", args: { size: "small", crust: "thin", toppings: [], quantity: 1 } },
    ]);

    const removeTurn = await t.turn("Remove that pizza", [
      { tool: "remove_pizza", args: { pizza_id: 1 } },
    ]);
    const result = removeTurn.toolResult<{ itemCount: number }>("remove_pizza");
    expect(result.itemCount).toBe(0);
  });

  test("update pizza toppings", async () => {
    const t = await createTestHarness(join(__dirname));

    await t.turn("Add a pizza", [
      {
        tool: "add_pizza",
        args: { size: "medium", crust: "regular", toppings: ["cheese"], quantity: 1 },
      },
    ]);

    const updateTurn = await t.turn("Add pepperoni to that", [
      { tool: "update_pizza", args: { pizza_id: 1, toppings: ["cheese", "pepperoni"] } },
    ]);
    const updated = updateTurn.toolResult<{ updated: { toppings: string[] } }>("update_pizza");
    expect(updated.updated.toppings).toContain("pepperoni");
  });

  test("cannot place empty order", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Place my order", [{ tool: "place_order", args: {} }]);
    const result = turn.toolResult<{ error: string }>("place_order");
    expect(result.error).toBe("Cannot place an empty order.");
  });

  test("full ordering flow", async () => {
    const t = await createTestHarness(join(__dirname));

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
    const order = placeTurn.toolResult<{
      orderNumber: string;
      customerName: string;
      pizzas: number;
    }>("place_order");
    expect(order.orderNumber).toBeDefined();
    expect(order.customerName).toBe("Alex");
    expect(order.pizzas).toBe(2);
  });
});
