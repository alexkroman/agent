import { calculateTotal, type Pizza } from "../shared.ts";

export const description = "View the current order summary with all pizzas and total price.";

export default async function execute(
  _args: Record<string, never>,
  ctx: { kv: { get: <T>(k: string) => Promise<T | undefined> } },
) {
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
}
