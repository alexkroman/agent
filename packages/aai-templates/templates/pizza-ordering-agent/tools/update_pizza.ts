import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { CRUSTS, cartSummary, findPizza, orderSlot, SIZES } from "../shared.ts";

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
    // The DRAFT's own pizza, so the four assignments below edit the cart:
    // `updateTool` hands the body a MUTABLE draft, which is what makes the
    // spread-into-a-copy and the write-back it then needed unnecessary.
    const pizza = findPizza(order, args.pizza_id);
    if (isToolFailure(pizza)) return pizza;

    if (args.size !== undefined) pizza.size = args.size;
    if (args.crust !== undefined) pizza.crust = args.crust;
    if (args.toppings !== undefined) pizza.toppings = args.toppings;
    if (args.quantity !== undefined) pizza.quantity = args.quantity;

    return { updated: pizza, ...cartSummary(order.pizzas) };
  },
});
