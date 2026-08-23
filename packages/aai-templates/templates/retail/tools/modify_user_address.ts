import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AddressFields, formatAddress, toAddress } from "../address.ts";
import { requireOwnUser, retailTool } from "../store.ts";

export default retailTool({
  name: "modify_user_address",
  when: "serving",
  description:
    "Change the customer's default address, used for future orders. Read the new address back and " +
    "get an explicit yes before calling this. This does not change the address on any existing " +
    "order — use modify_pending_order_address for that.",
  inputSchema: z.object({
    user_id: z.string().max(100).describe("The user id, e.g. 'sara_doe_496'"),
    ...AddressFields,
  }),
  execute: (args, state) => {
    const user = requireOwnUser(state, args.user_id);
    if (isToolFailure(user)) return user;

    user.address = toAddress(args);
    return {
      user_id: user.user_id,
      address: user.address,
      message: `Default address updated to ${formatAddress(user.address)}. Existing orders keep their own shipping addresses.`,
    };
  },
  summary: (_args, result) => `re-addressed ${result.user_id}`,
});
