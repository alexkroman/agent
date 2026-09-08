import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { stageAction } from "../pending.ts";
import { OrderIdField } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";
import { planModifyItems } from "../swap.ts";

export default retailTool({
  name: "modify_pending_order_items",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE a change of items in a pending order to different options of the SAME products — this " +
    "does NOT change anything. It can only ever be done ONCE per order and is irreversible: " +
    "afterwards the order can no longer be cancelled or modified at all. So collect EVERY item " +
    "the caller wants changed into one call — ask them 'is that everything you want to change?' " +
    "explicitly first. The whole list and the price difference come back as a sentence to read " +
    "to them; nothing happens until you hear an explicit yes and call confirm_change. The item " +
    "and replacement lists are positional and must be the same length.",
  inputSchema: z.object({
    order_id: OrderIdField,
    item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Item ids to change. May repeat if the order holds duplicates"),
    new_item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Replacement item ids, each matching the item in the same position"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("Method to charge or refund the price difference, e.g. 'gift_card_0000000'"),
  }),
  execute: (args, state) => {
    const plan = planModifyItems(
      state,
      args.order_id,
      args.item_ids,
      args.new_item_ids,
      args.payment_method_id,
    );
    if (isToolFailure(plan)) return plan;
    setFocus(state, { orderId: plan.orderId });
    return stageAction(state, { kind: "modify_pending_order_items", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
