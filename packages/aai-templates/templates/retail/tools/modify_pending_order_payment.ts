import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { planPayment } from "../payment.ts";
import { stageAction } from "../pending.ts";
import { OrderIdField } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "modify_pending_order_payment",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE a change to which payment method a pending order is charged to — this does NOT change " +
    "it. The new method must be different from the current one, and a gift card must hold enough " +
    "to cover the whole order; the original method is refunded. The change comes back as a " +
    "sentence to read to the caller; nothing happens until you hear an explicit yes and call " +
    "confirm_change.",
  inputSchema: z.object({
    order_id: OrderIdField,
    payment_method_id: z
      .string()
      .max(80)
      .describe("The new payment method id, e.g. 'gift_card_0000000'"),
  }),
  execute: (args, state) => {
    const plan = planPayment(state, args.order_id, args.payment_method_id);
    if (isToolFailure(plan)) return plan;
    setFocus(state, { orderId: plan.orderId });
    return stageAction(state, { kind: "modify_pending_order_payment", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
