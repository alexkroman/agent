import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { CANCEL_REASONS, planCancel } from "../cancel.ts";
import { stageAction } from "../pending.ts";
import { OrderIdField } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "cancel_pending_order",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE a cancellation of a pending order — this does NOT cancel anything. Only an order whose " +
    "status is exactly 'pending' can be cancelled, and the reason must be either 'no longer " +
    "needed' or 'ordered by mistake'. The order, its total and where the refund goes come back as " +
    "a sentence to read to the caller; nothing happens until you hear an explicit yes and call " +
    "confirm_change.",
  inputSchema: z.object({
    order_id: OrderIdField,
    reason: z
      .enum(CANCEL_REASONS)
      .describe("Either 'no longer needed' or 'ordered by mistake' — no other reason is accepted"),
  }),
  execute: (args, state) => {
    const plan = planCancel(state, args.order_id, args.reason);
    if (isToolFailure(plan)) return plan;
    setFocus(state, { orderId: plan.orderId });
    return stageAction(state, { kind: "cancel_pending_order", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
