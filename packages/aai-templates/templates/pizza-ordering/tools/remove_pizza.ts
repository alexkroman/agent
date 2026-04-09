import { calculateTotal, type Pizza } from "../shared.ts";

export const description = "Remove a pizza from the order by its ID.";

export const parameters = {
  type: "object",
  properties: {
    pizza_id: { type: "number", description: "The pizza ID to remove" },
  },
  required: ["pizza_id"],
};

export default async function execute(
  args: { pizza_id: number },
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

  const removed = pizzas[idx];
  const remaining = pizzas.filter((_, i) => i !== idx);
  await ctx.kv.set("pizzas", remaining);

  const total = calculateTotal(remaining);
  return {
    removed,
    orderTotal: `$${total.toFixed(2)}`,
    itemCount: remaining.length,
  };
}
