import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { CRUSTS, calculateTotal, type Pizza, SIZES } from "./shared.ts";
import systemPrompt from "./system-prompt.md";

const sizes = z.enum(SIZES);
const crusts = z.enum(CRUSTS);

// KV is scoped per deployment, not per session — prefix every key with the
// session ID so concurrent customers each get their own cart.
const pizzasKey = (sessionId: string) => `pizzas:${sessionId}`;
const nextIdKey = (sessionId: string) => `nextId:${sessionId}`;
const customerNameKey = (sessionId: string) => `customerName:${sessionId}`;

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
        quantity: z.number().int().min(1).default(1),
      }),
      async execute(args, ctx) {
        const [storedPizzas, storedNextId] = await Promise.all([
          ctx.kv.get<Pizza[]>(pizzasKey(ctx.sessionId)),
          ctx.kv.get<number>(nextIdKey(ctx.sessionId)),
        ]);
        const pizzas = storedPizzas ?? [];
        const nextId = storedNextId ?? 1;

        const pizza: Pizza = {
          id: nextId,
          size: args.size,
          crust: args.crust,
          toppings: args.toppings,
          quantity: args.quantity,
        };
        const updated = [...pizzas, pizza];

        await Promise.all([
          ctx.kv.set(pizzasKey(ctx.sessionId), updated),
          ctx.kv.set(nextIdKey(ctx.sessionId), nextId + 1),
        ]);

        const total = calculateTotal(updated);
        const result = {
          added: pizza,
          orderTotal: `$${total.toFixed(2)}`,
          itemCount: updated.length,
        };
        ctx.send("order", result);
        return result;
      },
    }),

    place_order: tool({
      description:
        "Place the final order. Use when the customer confirms they are done and ready to order.",
      async execute(_args, ctx) {
        const [storedPizzas, storedName] = await Promise.all([
          ctx.kv.get<Pizza[]>(pizzasKey(ctx.sessionId)),
          ctx.kv.get<string>(customerNameKey(ctx.sessionId)),
        ]);
        const pizzas = storedPizzas ?? [];
        if (pizzas.length === 0) return { error: "Cannot place an empty order." };

        const customerName = storedName ?? "Guest";
        const total = calculateTotal(pizzas);
        const orderNumber = Math.floor(1000 + Math.random() * 9000);

        // The order is submitted — clear the cart so a follow-up order
        // starts fresh instead of inheriting these pizzas.
        await ctx.kv.delete([
          pizzasKey(ctx.sessionId),
          nextIdKey(ctx.sessionId),
          customerNameKey(ctx.sessionId),
        ]);

        const result = {
          orderNumber,
          customerName,
          pizzas: pizzas.length,
          total: `$${total.toFixed(2)}`,
          estimatedMinutes: 15 + pizzas.length * 5,
        };
        ctx.send("order", result);
        return result;
      },
    }),

    remove_pizza: tool({
      description: "Remove a pizza from the order by its ID.",
      parameters: z.object({
        pizza_id: z.number().describe("The pizza ID to remove"),
      }),
      async execute(args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get(pizzasKey(ctx.sessionId))) ?? [];
        const idx = pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };

        const removed = pizzas[idx];
        const remaining = pizzas.filter((_, i) => i !== idx);
        await ctx.kv.set(pizzasKey(ctx.sessionId), remaining);

        const total = calculateTotal(remaining);
        const result = {
          removed,
          orderTotal: `$${total.toFixed(2)}`,
          itemCount: remaining.length,
        };
        ctx.send("order", result);
        return result;
      },
    }),

    set_customer_name: tool({
      description: "Set the customer name for the order.",
      parameters: z.object({
        name: z.string(),
      }),
      async execute(args, ctx) {
        await ctx.kv.set(customerNameKey(ctx.sessionId), args.name);
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
        quantity: z.number().int().min(1).optional(),
      }),
      async execute(args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get(pizzasKey(ctx.sessionId))) ?? [];
        const idx = pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };

        const pizza: Pizza = { ...pizzas[idx]! };
        if (args.size !== undefined) pizza.size = args.size;
        if (args.crust !== undefined) pizza.crust = args.crust;
        if (args.toppings !== undefined) pizza.toppings = args.toppings;
        if (args.quantity !== undefined) pizza.quantity = args.quantity;

        const updated = [...pizzas];
        updated[idx] = pizza;
        await ctx.kv.set(pizzasKey(ctx.sessionId), updated);

        const total = calculateTotal(updated);
        const result = {
          updated: pizza,
          orderTotal: `$${total.toFixed(2)}`,
        };
        ctx.send("order", result);
        return result;
      },
    }),

    view_order: tool({
      description: "View the current order summary with all pizzas and total price.",
      async execute(_args, ctx) {
        const pizzas: Pizza[] = (await ctx.kv.get(pizzasKey(ctx.sessionId))) ?? [];
        if (pizzas.length === 0) return { message: "The order is empty." };

        const total = calculateTotal(pizzas);
        const result = {
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
        ctx.send("order", result);
        return result;
      },
    }),
  },
});
