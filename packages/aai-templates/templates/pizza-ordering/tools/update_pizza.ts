import { calculateTotal, type Pizza } from "../shared.ts";

export const description =
  "Update an existing pizza in the order. Only provided fields are changed.";

export const parameters = {
  type: "object",
  properties: {
    pizza_id: { type: "number" },
    size: { type: "string", enum: ["small", "medium", "large"] },
    crust: { type: "string", enum: ["thin", "regular", "thick", "stuffed"] },
    toppings: { type: "array", items: { type: "string" } },
    quantity: { type: "number" },
  },
  required: ["pizza_id"],
};

export default async function execute(
  args: {
    pizza_id: number;
    size?: Pizza["size"];
    crust?: Pizza["crust"];
    toppings?: string[];
    quantity?: number;
  },
  ctx: {
    kv: {
      get: <T>(k: string) => Promise<T | undefined>;
      set: (k: string, v: unknown) => Promise<void>;
    };
  },
) {
  const pizzas: Pizza[] = (await ctx.kv.get("pizzas")) ?? [];
  const idx = pizzas.findIndex((p) => p.id === args.pizza_id);
  if (idx === -1) return { error: "Pizza not found in the order." };

  const pizza = { ...pizzas[idx] };
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
}
