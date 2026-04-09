import { calculateTotal, type Pizza } from "../shared.ts";

export const description =
  "Add a pizza to the order. Use when the customer has decided on a pizza.";

export const parameters = {
  type: "object",
  properties: {
    size: { type: "string", enum: ["small", "medium", "large"] },
    crust: { type: "string", enum: ["thin", "regular", "thick", "stuffed"] },
    toppings: {
      type: "array",
      items: { type: "string" },
      description: "List of topping names, e.g. ['pepperoni', 'mushrooms']",
    },
    quantity: { type: "number", default: 1 },
  },
  required: ["size", "crust", "toppings"],
};

export default async function execute(
  args: { size: Pizza["size"]; crust: Pizza["crust"]; toppings: string[]; quantity?: number },
  ctx: {
    kv: {
      get: <T>(k: string) => Promise<T | undefined>;
      set: (k: string, v: unknown) => Promise<void>;
    };
  },
) {
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
}
