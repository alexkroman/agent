import { calculateTotal, type Pizza } from "../shared.ts";

export default async function execute(
  _args: Record<string, never>,
  ctx: {
    kv: {
      get: <T>(k: string) => Promise<T | undefined>;
      set: (k: string, v: unknown) => Promise<void>;
    };
  },
) {
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
}
