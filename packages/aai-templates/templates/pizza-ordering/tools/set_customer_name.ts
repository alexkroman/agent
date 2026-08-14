import { z } from "zod";
import { orderSlot } from "../shared.ts";

export default orderSlot.tool({
  description: "Set the customer name for the order.",
  inputSchema: z.object({
    name: z.string(),
  }),
  execute(args, order) {
    order.customerName = args.name;
    return { name: args.name };
  },
});
