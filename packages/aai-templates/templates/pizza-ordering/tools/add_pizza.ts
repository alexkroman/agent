import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { CRUSTS, calculateTotal, orderSlot, type Pizza, SIZES } from "../shared.ts";

export default orderSlot.updateTool({
  description: "Add a pizza to the order. Use when the customer has decided on a pizza.",
  inputSchema: z.object({
    size: z.enum(SIZES),
    crust: z.enum(CRUSTS),
    toppings: z
      .array(z.string())
      .describe("List of topping names, e.g. ['pepperoni', 'mushrooms']"),
    quantity: z.number().int().min(1).default(1),
  }),
  execute(args, order) {
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
      orderTotal: formatMoney(calculateTotal(order.pizzas)),
      itemCount: order.pizzas.length,
    };
  },
});
