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
  sizes: { small: 8.99, medium: 11.99, large: 14.99 } as Record<string, number>,
  crusts: { thin: 0, regular: 0, thick: 1.0, stuffed: 2.0 } as Record<string, number>,
  toppings: {
    pepperoni: 1.5, sausage: 1.5, mushrooms: 1.0, onions: 1.0,
    green_peppers: 1.0, black_olives: 1.0, bacon: 2.0, ham: 1.5,
    pineapple: 1.0, jalapenos: 1.0, extra_cheese: 1.5, spinach: 1.0,
    tomatoes: 1.0, anchovies: 1.5, chicken: 2.0,
  } as Record<string, number>,
};

function calculateTotal(pizzas: Pizza[]): number {
  return pizzas.reduce((total, pizza) => {
    const base = MENU.sizes[pizza.size] ?? 11.99;
    const crust = MENU.crusts[pizza.crust] ?? 0;
    const toppingsPrice = pizza.toppings.reduce(
      (sum, t) => sum + (MENU.toppings[t] ?? 1.0),
      0,
    );
    return total + (base + crust + toppingsPrice) * pizza.quantity;
  }, 0);
}

export default {
  state: (): OrderState => ({
    pizzas: [],
    nextId: 1,
    customerName: "",
    orderPlaced: false,
  }),

  tools: {
    add_pizza: {
      description: "Add a pizza to the order. Use when the customer has decided on a pizza.",
      parameters: {
        type: "object" as const,
        properties: {
          size: { type: "string", enum: ["small", "medium", "large"] },
          crust: { type: "string", enum: ["thin", "regular", "thick", "stuffed"] },
          toppings: { type: "array", items: { type: "string" }, description: "List of topping names, e.g. ['pepperoni', 'mushrooms']" },
          quantity: { type: "number", description: "Number of this pizza, defaults to 1" },
        },
        required: ["size", "crust", "toppings"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<OrderState>) => {
        const state = ctx.state;
        const pizza: Pizza = {
          id: state.nextId++,
          size: args.size as Pizza["size"],
          crust: args.crust as Pizza["crust"],
          toppings: args.toppings as string[],
          quantity: (args.quantity as number) || 1,
        };
        state.pizzas.push(pizza);
        const total = calculateTotal(state.pizzas);
        return { added: pizza, orderTotal: `$${total.toFixed(2)}`, itemCount: state.pizzas.length };
      },
    },

    remove_pizza: {
      description: "Remove a pizza from the order by its ID.",
      parameters: {
        type: "object" as const,
        properties: {
          pizza_id: { type: "number", description: "The pizza ID to remove" },
        },
        required: ["pizza_id"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<OrderState>) => {
        const state = ctx.state;
        const pizzaId = args.pizza_id as number;
        const idx = state.pizzas.findIndex((p) => p.id === pizzaId);
        if (idx === -1) return { error: "Pizza not found in the order." };
        const removed = state.pizzas.splice(idx, 1)[0];
        const total = calculateTotal(state.pizzas);
        return { removed, orderTotal: `$${total.toFixed(2)}`, itemCount: state.pizzas.length };
      },
    },

    update_pizza: {
      description: "Update an existing pizza in the order. Only provided fields are changed.",
      parameters: {
        type: "object" as const,
        properties: {
          pizza_id: { type: "number" },
          size: { type: "string", enum: ["small", "medium", "large"] },
          crust: { type: "string", enum: ["thin", "regular", "thick", "stuffed"] },
          toppings: { type: "array", items: { type: "string" } },
          quantity: { type: "number" },
        },
        required: ["pizza_id"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<OrderState>) => {
        const state = ctx.state;
        const pizza = state.pizzas.find((p) => p.id === (args.pizza_id as number));
        if (!pizza) return { error: "Pizza not found in the order." };
        if (args.size) pizza.size = args.size as Pizza["size"];
        if (args.crust) pizza.crust = args.crust as Pizza["crust"];
        if (args.toppings) pizza.toppings = args.toppings as string[];
        if (args.quantity) pizza.quantity = args.quantity as number;
        const total = calculateTotal(state.pizzas);
        return { updated: pizza, orderTotal: `$${total.toFixed(2)}` };
      },
    },

    view_order: {
      description: "View the current order summary with all pizzas and total price.",
      execute: (_args: Record<string, unknown>, ctx: ToolContext<OrderState>) => {
        const state = ctx.state;
        if (state.pizzas.length === 0) return { message: "The order is empty." };
        const total = calculateTotal(state.pizzas);
        return {
          pizzas: state.pizzas.map((p) => ({
            id: p.id,
            description: `${p.quantity}x ${p.size} ${p.crust} crust with ${p.toppings.length > 0 ? p.toppings.join(", ") : "cheese only"}`,
            size: p.size, crust: p.crust, toppings: p.toppings, quantity: p.quantity,
          })),
          orderTotal: `$${total.toFixed(2)}`,
        };
      },
    },

    set_customer_name: {
      description: "Set the customer name for the order.",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<OrderState>) => {
        const state = ctx.state;
        state.customerName = args.name as string;
        return { name: state.customerName };
      },
    },

    place_order: {
      description: "Place the final order. Use when the customer confirms they are done and ready to order.",
      execute: (_args: Record<string, unknown>, ctx: ToolContext<OrderState>) => {
        const state = ctx.state;
        if (state.pizzas.length === 0) return { error: "Cannot place an empty order." };
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
} satisfies AgentTools<OrderState>;
