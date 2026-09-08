import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AddressFields, planUserAddress } from "../address.ts";
import { stageAction } from "../pending.ts";
import { retailTool } from "../store.ts";

export default retailTool({
  name: "modify_user_address",
  when: "serving",
  send: { type: "STAGED" },
  description:
    "STAGE a change to the customer's default address, used for future orders — this does NOT " +
    "change it. The new address comes back as a sentence to read to the caller; nothing happens " +
    "until you hear an explicit yes and call confirm_change. This does not change the address on " +
    "any existing order — use modify_pending_order_address for that.",
  inputSchema: z.object({
    user_id: z.string().max(100).describe("The user id, e.g. 'sara_doe_496'"),
    ...AddressFields,
  }),
  execute: (args, state) => {
    const plan = planUserAddress(state, args.user_id, args);
    if (isToolFailure(plan)) return plan;
    return stageAction(state, { kind: "modify_user_address", plan });
  },
  summary: (_args, result) => `staged: ${result.read_back}`,
});
