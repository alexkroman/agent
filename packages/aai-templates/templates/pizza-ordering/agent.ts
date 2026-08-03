import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  CRUSTS,
  calculateTotal,
  formatPrice,
  getOrder,
  menuText,
  orderView,
  type Pizza,
  resetOrder,
  SIZES,
} from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

const sizes = z.enum(SIZES);
const crusts = z.enum(CRUSTS);

// The in-progress order lives in `ctx.state` (see shared.ts) — per-session by
// construction, so concurrent customers each get their own cart.

export default agent({
  name: "Pizza Palace",
  // The cart, pushed to the client after every tool call. Replaces a
  // `ctx.send("order", ...)` in each of the five order tools, and the
  // event-diffing the client had to do to rebuild the cart from them.
  syncState: orderView,
  // The menu section is generated from MENU so the prompt can never quote a
  // price the pricing code doesn't charge.
  systemPrompt: `${systemPrompt}\n${menuText()}`,
  greeting:
    "Welcome to Pizza Palace. I can help you build your perfect pizza. What would you like to order?",

  tools: {
    add_pizza: tool({
      description: "Add a pizza to the order. Use when the customer has decided on a pizza.",
      inputSchema: z.object({
        size: sizes,
        crust: crusts,
        toppings: z
          .array(z.string())
          .describe("List of topping names, e.g. ['pepperoni', 'mushrooms']"),
        quantity: z.number().int().min(1).default(1),
      }),
      async execute(args, ctx) {
        const order = getOrder(ctx);

        const pizza: Pizza = {
          id: order.nextId,
          size: args.size,
          crust: args.crust,
          toppings: args.toppings,
          quantity: args.quantity,
        };
        order.pizzas.push(pizza);
        order.nextId++;

        return {
          added: pizza,
          orderTotal: formatPrice(calculateTotal(order.pizzas)),
          itemCount: order.pizzas.length,
        };
      },
    }),

    place_order: tool({
      description:
        "Place the final order. Use when the customer confirms they are done and ready to order.",
      async execute(_args, ctx) {
        const order = getOrder(ctx);
        const pizzas = order.pizzas;
        if (pizzas.length === 0) return { error: "Cannot place an empty order." };

        const customerName = order.customerName ?? "Guest";
        const total = formatPrice(calculateTotal(pizzas));
        const orderNumber = Math.floor(1000 + Math.random() * 9000);

        const estimatedMinutes = 15 + pizzas.length * 5;
        // The order is submitted — clear the cart so a follow-up order starts
        // fresh, but keep the confirmation in state so the UI can show it.
        resetOrder(ctx, { orderNumber, total, estimatedMinutes });

        return {
          orderNumber,
          customerName,
          pizzas: pizzas.length,
          total,
          estimatedMinutes,
        };
      },
    }),

    remove_pizza: tool({
      description: "Remove a pizza from the order by its ID.",
      inputSchema: z.object({
        pizza_id: z.number().describe("The pizza ID to remove"),
      }),
      async execute(args, ctx) {
        const order = getOrder(ctx);
        const idx = order.pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };

        const [removed] = order.pizzas.splice(idx, 1);

        return {
          removed,
          orderTotal: formatPrice(calculateTotal(order.pizzas)),
          itemCount: order.pizzas.length,
        };
      },
    }),

    set_customer_name: tool({
      description: "Set the customer name for the order.",
      inputSchema: z.object({
        name: z.string(),
      }),
      async execute(args, ctx) {
        getOrder(ctx).customerName = args.name;
        return { name: args.name };
      },
    }),

    update_pizza: tool({
      description: "Update an existing pizza in the order. Only provided fields are changed.",
      inputSchema: z.object({
        pizza_id: z.number(),
        size: sizes.optional(),
        crust: crusts.optional(),
        toppings: z.array(z.string()).optional(),
        quantity: z.number().int().min(1).optional(),
      }),
      async execute(args, ctx) {
        const order = getOrder(ctx);
        const idx = order.pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };

        const pizza: Pizza = { ...order.pizzas[idx]! };
        if (args.size !== undefined) pizza.size = args.size;
        if (args.crust !== undefined) pizza.crust = args.crust;
        if (args.toppings !== undefined) pizza.toppings = args.toppings;
        if (args.quantity !== undefined) pizza.quantity = args.quantity;

        order.pizzas[idx] = pizza;

        return {
          updated: pizza,
          orderTotal: formatPrice(calculateTotal(order.pizzas)),
        };
      },
    }),

    view_order: tool({
      description: "View the current order summary with all pizzas and total price.",
      async execute(_args, ctx) {
        const pizzas = getOrder(ctx).pizzas;
        if (pizzas.length === 0) return { message: "The order is empty." };

        return {
          pizzas: pizzas.map((p) => ({
            id: p.id,
            description: `${p.quantity}x ${p.size} ${p.crust} crust with ${p.toppings.length > 0 ? p.toppings.join(", ") : "cheese only"}`,
            size: p.size,
            crust: p.crust,
            toppings: p.toppings,
            quantity: p.quantity,
          })),
          orderTotal: formatPrice(calculateTotal(pizzas)),
        };
      },
    }),
  },
});
