import { agent, tool } from "aai";
import { z } from "zod";
import { calculateTotal, type Pizza } from "./shared.ts";
import systemPrompt from "./system-prompt.md";

const sizes = z.enum(["small", "medium", "large"]);
const crusts = z.enum(["thin", "regular", "thick", "stuffed"]);

export default agent({
  name: "Pizza Palace",
  systemPrompt,
  greeting:
    "Welcome to Pizza Palace. I can help you build your perfect pizza. What would you like to order?",

  tools: {
    add_pizza: tool({
      description: "Add a pizza to the order. Use when the customer has decided on a pizza.",
      parameters: z.object({
        size: sizes,
        crust: crusts,
        toppings: z
          .array(z.string())
          .describe("List of topping names, e.g. ['pepperoni', 'mushrooms']"),
        quantity: z.number().default(1),
      }),
      async execute(args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get("pizzas")) ?? [];
        const nextId: number = (await ctx.kv.get("nextId")) ?? 1;

        const pizza: Pizza = {
          id: nextId,
          size: args.size,
          crust: args.crust,
          toppings: args.toppings,
          quantity: args.quantity ?? 1,
        };

        await ctx.kv.set("pizzas", [...pizzas, pizza]);
        await ctx.kv.set("nextId", nextId + 1);

        const total = calculateTotal([...pizzas, pizza]);
        return {
          added: pizza,
          orderTotal: `$${total.toFixed(2)}`,
          itemCount: pizzas.length + 1,
        };
      },
    }),

    place_order: tool({
      description:
        "Place the final order. Use when the customer confirms they are done and ready to order.",
      async execute(_args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get("pizzas")) ?? [];
        if (pizzas.length === 0) return { error: "Cannot place an empty order." };

        await ctx.kv.set("orderPlaced", true);
        const customerName: string = (await ctx.kv.get("customerName")) ?? "Guest";
        const total = calculateTotal(pizzas);
        const orderNumber = Math.floor(1000 + Math.random() * 9000);

        return {
          orderNumber,
          customerName,
          pizzas: pizzas.length,
          total: `$${total.toFixed(2)}`,
          estimatedMinutes: 15 + pizzas.length * 5,
        };
      },
    }),

    remove_pizza: tool({
      description: "Remove a pizza from the order by its ID.",
      parameters: z.object({
        pizza_id: z.number().describe("The pizza ID to remove"),
      }),
      async execute(args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get("pizzas")) ?? [];
        const idx = pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };

        const removed = pizzas[idx];
        const remaining = pizzas.filter((_, i) => i !== idx);
        await ctx.kv.set("pizzas", remaining);

        const total = calculateTotal(remaining);
        return {
          removed,
          orderTotal: `$${total.toFixed(2)}`,
          itemCount: remaining.length,
        };
      },
    }),

    set_customer_name: tool({
      description: "Set the customer name for the order.",
      parameters: z.object({
        name: z.string(),
      }),
      async execute(args, ctx) {
        await ctx.kv.set("customerName", args.name);
        return { name: args.name };
      },
    }),

    update_pizza: tool({
      description: "Update an existing pizza in the order. Only provided fields are changed.",
      parameters: z.object({
        pizza_id: z.number(),
        size: sizes.optional(),
        crust: crusts.optional(),
        toppings: z.array(z.string()).optional(),
        quantity: z.number().optional(),
      }),
      async execute(args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get("pizzas")) ?? [];
        const idx = pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };

        const pizza: Pizza = { ...pizzas[idx]! };
        if (args.size) pizza.size = args.size;
        if (args.crust) pizza.crust = args.crust;
        if (args.toppings) pizza.toppings = args.toppings;
        if (args.quantity) pizza.quantity = args.quantity;

        const updated = [...pizzas];
        updated[idx] = pizza;
        await ctx.kv.set("pizzas", updated);

        const total = calculateTotal(updated);
        return {
          updated: pizza,
          orderTotal: `$${total.toFixed(2)}`,
        };
      },
    }),

    view_order: tool({
      description: "View the current order summary with all pizzas and total price.",
      async execute(_args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get("pizzas")) ?? [];
        if (pizzas.length === 0) return { message: "The order is empty." };

        const total = calculateTotal(pizzas);
        return {
          pizzas: pizzas.map((p) => ({
            id: p.id,
            description: `${p.quantity}x ${p.size} ${p.crust} crust with ${p.toppings.length > 0 ? p.toppings.join(", ") : "cheese only"}`,
            size: p.size,
            crust: p.crust,
            toppings: p.toppings,
            quantity: p.quantity,
          })),
          orderTotal: `$${total.toFixed(2)}`,
        };
      },
    }),
  },
});
