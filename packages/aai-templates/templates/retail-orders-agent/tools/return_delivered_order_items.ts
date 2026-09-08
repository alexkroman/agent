import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { stageAction } from "../pending.ts";
import { OrderIdField } from "../resolve.ts";
import { planReturn } from "../returns.ts";
import { retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "return_delivered_order_items",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE a return of items from a delivered order — this does NOT request anything. Only a " +
    "'delivered' order can be returned, and only once. The refund must go to the order's ORIGINAL " +
    "payment method or to one of the customer's gift cards. The exact item list and the refund " +
    "destination come back as a sentence to read to the caller; nothing happens until you hear an " +
    "explicit yes and call confirm_change. The customer then gets an email explaining how to send " +
    "the items back.",
  inputSchema: z.object({
    order_id: OrderIdField,
    item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Item ids to return. May repeat if the order holds duplicates"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("Where the refund goes — the original method, or one of their gift cards"),
  }),
  execute: (args, state) => {
    const plan = planReturn(state, args.order_id, args.item_ids, args.payment_method_id);
    if (isToolFailure(plan)) return plan;
    setFocus(state, { orderId: plan.orderId });
    return stageAction(state, { kind: "return_delivered_order_items", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
