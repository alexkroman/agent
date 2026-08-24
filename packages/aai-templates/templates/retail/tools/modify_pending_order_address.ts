import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AddressFields, planOrderAddress } from "../address.ts";
import { stageAction } from "../pending.ts";
import { OrderIdField } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "modify_pending_order_address",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE a change to a pending order's shipping address — this does NOT change it. The new " +
    "address comes back as a sentence to read to the caller; nothing happens until you hear an " +
    "explicit yes and call confirm_change. This does not touch the customer's default address.",
  inputSchema: z.object({
    order_id: OrderIdField,
    ...AddressFields,
  }),
  execute: (args, state) => {
    const plan = planOrderAddress(state, args.order_id, args);
    if (isToolFailure(plan)) return plan;
    setFocus(state, { orderId: plan.orderId });
    return stageAction(state, { kind: "modify_pending_order_address", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
