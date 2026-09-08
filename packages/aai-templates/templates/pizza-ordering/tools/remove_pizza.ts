import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { cartSummary, findPizza, orderSlot } from "../shared.ts";

export default orderSlot.updateTool({
  description: "Remove a pizza from the order by its ID.",
  inputSchema: z.object({
    pizza_id: z.number().describe("The pizza ID to remove"),
  }),
  execute(args, order) {
    const removed = findPizza(order, args.pizza_id);
    if (isToolFailure(removed)) return removed;

    order.pizzas.splice(order.pizzas.indexOf(removed), 1);

    return { removed, ...cartSummary(order.pizzas) };
  },
});
