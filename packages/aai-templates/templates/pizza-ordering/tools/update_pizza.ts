import { toolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { CRUSTS, calculateTotal, orderSlot, type Pizza, SIZES } from "../shared.ts";

export default orderSlot.updateTool({
  description: "Update an existing pizza in the order. Only provided fields are changed.",
  inputSchema: z.object({
    pizza_id: z.number(),
    size: z.enum(SIZES).optional(),
    crust: z.enum(CRUSTS).optional(),
    toppings: z.array(z.string()).optional(),
    quantity: z.number().int().min(1).optional(),
  }),
  execute(args, order) {
    const idx = order.pizzas.findIndex((p) => p.id === args.pizza_id);
    if (idx === -1) return toolFailure("Pizza not found in the order.");

    const pizza: Pizza = { ...order.pizzas[idx]! };
    if (args.size !== undefined) pizza.size = args.size;
    if (args.crust !== undefined) pizza.crust = args.crust;
    if (args.toppings !== undefined) pizza.toppings = args.toppings;
    if (args.quantity !== undefined) pizza.quantity = args.quantity;

    order.pizzas[idx] = pizza;

    return { updated: pizza, orderTotal: formatMoney(calculateTotal(order.pizzas)) };
  },
});
