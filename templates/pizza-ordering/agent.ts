import { defineAgent } from "@alexkroman1/aai";
import { z } from "zod";

interface Pizza {
  id: number;
  size: "small" | "medium" | "large";
  crust: "thin" | "regular" | "thick" | "stuffed";
  toppings: string[];
  quantity: number;
}

interface OrderState {
  pizzas: Pizza[];
  nextId: number;
  customerName: string;
  orderPlaced: boolean;
}

const MENU = {
  sizes: { small: 8.99, medium: 11.99, large: 14.99 },
  crusts: { thin: 0, regular: 0, thick: 1.0, stuffed: 2.0 },
  toppings: {
    pepperoni: 1.5,
    sausage: 1.5,
    mushrooms: 1.0,
    onions: 1.0,
    green_peppers: 1.0,
    black_olives: 1.0,
    bacon: 2.0,
    ham: 1.5,
    pineapple: 1.0,
    jalapenos: 1.0,
    extra_cheese: 1.5,
    spinach: 1.0,
    tomatoes: 1.0,
    anchovies: 1.5,
    chicken: 2.0,
  },
} as const;

function calculateTotal(pizzas: Pizza[]): number {
  return pizzas.reduce((total, pizza) => {
    const base = MENU.sizes[pizza.size];
    const crust = MENU.crusts[pizza.crust];
    const toppingsPrice = pizza.toppings.reduce(
      (sum, t) =>
        sum + (MENU.toppings[t as keyof typeof MENU.toppings] ?? 1.0),
      0,
    );
    return total + (base + crust + toppingsPrice) * pizza.quantity;
  }, 0);
}

export default defineAgent({
  name: "Pizza Palace",
  voice: "e3827ec5-697a-4b7c-9704-1a23041bbc51", // Sweet Lady
  greeting:
    "Welcome to Pizza Palace. I can help you build your perfect pizza. What would you like to order?",
  instructions: `You are a friendly pizza order-taker at Pizza Palace. Keep responses short and conversational, optimized for voice.

Your job is to help customers build their pizza order step by step. Guide them through size, crust, and toppings.

Menu info:
- Sizes: small ($8.99), medium ($11.99), large ($14.99)
- Crusts: thin (free), regular (free), thick (+$1), stuffed (+$2)
- Toppings: pepperoni ($1.50), sausage ($1.50), mushrooms ($1), onions ($1), green peppers ($1), black olives ($1), bacon ($2), ham ($1.50), pineapple ($1), jalapenos ($1), extra cheese ($1.50), spinach ($1), tomatoes ($1), anchovies ($1.50), chicken ($2)

Behavior:
- When a customer wants a pizza, collect size, crust, and toppings, then use add_pizza to add it.
- If they just say something like "pepperoni pizza", assume medium, regular crust, and confirm before adding.
- Always confirm what you added after using add_pizza.
- Use view_order when the customer asks to review their order.
- Use update_pizza if they want to change an existing pizza.
- Use remove_pizza if they want to remove one.
- When they say they are done ordering, use place_order.
- Suggest popular combos if they seem unsure. For example, "Our most popular is a large pepperoni with extra cheese."
- Always mention the running total after changes.
- Be warm but efficient. No long monologues.`,

  state: (): OrderState => ({
    pizzas: [],
    nextId: 1,
    customerName: "",
    orderPlaced: false,
  }),

  tools: {
    add_pizza: {
      description:
        "Add a pizza to the order. Use when the customer has decided on a pizza.",
      parameters: z.object({
        size: z.enum(["small", "medium", "large"]),
        crust: z.enum(["thin", "regular", "thick", "stuffed"]),
        toppings: z
          .array(z.string())
          .describe("List of topping names, e.g. ['pepperoni', 'mushrooms']"),
        quantity: z.number().default(1),
      }),
      execute: (args: { size: Pizza["size"]; crust: Pizza["crust"]; toppings: string[]; quantity: number }, ctx) => {
        const state = ctx.state as OrderState;
        const pizza: Pizza = {
          id: state.nextId++,
          size: args.size,
          crust: args.crust,
          toppings: args.toppings,
          quantity: args.quantity,
        };
        state.pizzas.push(pizza);
        const total = calculateTotal(state.pizzas);
        return {
          added: pizza,
          orderTotal: `$${total.toFixed(2)}`,
          itemCount: state.pizzas.length,
        };
      },
    },

    remove_pizza: {
      description: "Remove a pizza from the order by its ID.",
      parameters: z.object({
        pizza_id: z.number().describe("The pizza ID to remove"),
      }),
      execute: (args, ctx) => {
        const state = ctx.state as OrderState;
        const idx = state.pizzas.findIndex((p) => p.id === args.pizza_id);
        if (idx === -1) return { error: "Pizza not found in the order." };
        const removed = state.pizzas.splice(idx, 1)[0];
        const total = calculateTotal(state.pizzas);
        return {
          removed,
          orderTotal: `$${total.toFixed(2)}`,
          itemCount: state.pizzas.length,
        };
      },
    },

    update_pizza: {
      description:
        "Update an existing pizza in the order. Only provided fields are changed.",
      parameters: z.object({
        pizza_id: z.number(),
        size: z.enum(["small", "medium", "large"]).optional(),
        crust: z.enum(["thin", "regular", "thick", "stuffed"]).optional(),
        toppings: z.array(z.string()).optional(),
        quantity: z.number().optional(),
      }),
      execute: (args: { pizza_id: number; size?: Pizza["size"]; crust?: Pizza["crust"]; toppings?: string[]; quantity?: number }, ctx) => {
        const state = ctx.state as OrderState;
        const pizza = state.pizzas.find((p) => p.id === args.pizza_id);
        if (!pizza) return { error: "Pizza not found in the order." };
        if (args.size) pizza.size = args.size;
        if (args.crust) pizza.crust = args.crust;
        if (args.toppings) pizza.toppings = args.toppings;
        if (args.quantity) pizza.quantity = args.quantity;
        const total = calculateTotal(state.pizzas);
        return {
          updated: pizza,
          orderTotal: `$${total.toFixed(2)}`,
        };
      },
    },

    view_order: {
      description:
        "View the current order summary with all pizzas and total price.",
      execute: (_args, ctx) => {
        const state = ctx.state as OrderState;
        if (state.pizzas.length === 0)
          return { message: "The order is empty." };
        const total = calculateTotal(state.pizzas);
        return {
          pizzas: state.pizzas.map((p) => ({
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
    },

    set_customer_name: {
      description: "Set the customer name for the order.",
      parameters: z.object({ name: z.string() }),
      execute: (args: { name: string }, ctx) => {
        const state = ctx.state as OrderState;
        state.customerName = args.name;
        return { name: args.name };
      },
    },

    place_order: {
      description:
        "Place the final order. Use when the customer confirms they are done and ready to order.",
      execute: (_args, ctx) => {
        const state = ctx.state as OrderState;
        if (state.pizzas.length === 0)
          return { error: "Cannot place an empty order." };
        state.orderPlaced = true;
        const total = calculateTotal(state.pizzas);
        const orderNumber = Math.floor(1000 + Math.random() * 9000);
        return {
          orderNumber,
          customerName: state.customerName || "Guest",
          pizzas: state.pizzas.length,
          total: `$${total.toFixed(2)}`,
          estimatedMinutes: 15 + state.pizzas.length * 5,
        };
      },
    },
  },
});
