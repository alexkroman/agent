import { toolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { calculateTotal, orderSlot } from "../shared.ts";

export default orderSlot.updateTool({
  description: "Remove a pizza from the order by its ID.",
  inputSchema: z.object({
    pizza_id: z.number().describe("The pizza ID to remove"),
  }),
  execute(args, order) {
    const idx = order.pizzas.findIndex((p) => p.id === args.pizza_id);
    if (idx === -1) return toolFailure("Pizza not found in the order.");

    const [removed] = order.pizzas.splice(idx, 1);

    return {
      removed,
      orderTotal: formatMoney(calculateTotal(order.pizzas)),
      itemCount: order.pizzas.length,
    };
  },
});
