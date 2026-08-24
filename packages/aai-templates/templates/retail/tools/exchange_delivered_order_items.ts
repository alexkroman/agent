import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { stageAction } from "../pending.ts";
import { OrderIdField } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";
import { planExchange } from "../swap.ts";

export default retailTool({
  name: "exchange_delivered_order_items",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE an exchange of items in a delivered order for different options of the SAME products — " +
    "this does NOT request anything. Only a 'delivered' order can be exchanged, and only once, so " +
    "remind the caller to name EVERY item they want exchanged before you call this. The whole " +
    "list and the price difference come back as a sentence to read to them; nothing happens until " +
    "you hear an explicit yes and call confirm_change. No new order is needed — the customer gets " +
    "an email explaining how to send the originals back.",
  inputSchema: z.object({
    order_id: OrderIdField,
    item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Item ids to exchange. May repeat if the order holds duplicates"),
    new_item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Replacement item ids, each matching the item in the same position"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("Method to charge or refund the price difference"),
  }),
  execute: (args, state) => {
    const plan = planExchange(
      state,
      args.order_id,
      args.item_ids,
      args.new_item_ids,
      args.payment_method_id,
    );
    if (isToolFailure(plan)) return plan;
    setFocus(state, { orderId: plan.orderId });
    return stageAction(state, { kind: "exchange_delivered_order_items", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
