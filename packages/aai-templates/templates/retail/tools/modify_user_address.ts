import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AddressFields, formatAddress, toAddress } from "../address.ts";
import { authenticatedUser, retailSlot, retailTool } from "../store.ts";

export const modifyUserAddress = retailTool({
  name: "modify_user_address",
  description:
    "Change the customer's default address, used for future orders. Read the new address back and " +
    "get an explicit yes before calling this. This does not change the address on any existing " +
    "order — use modify_pending_order_address for that.",
  input: z.object({
    user_id: z.string().max(100).describe("The user id, e.g. 'sara_doe_496'"),
    ...AddressFields,
  }),
  // `run` before `summary`: TS infers the wrapper's generic `R` from
  // `run`'s return type, and processes object literal properties in
  // source order — with `summary` first, `result` in its signature can't be
  // inferred and silently falls back to `unknown`.
  run: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const user = authenticatedUser(state);
    if (isToolFailure(user)) return user;
    if (user.user_id !== args.user_id) {
      return {
        error: `${args.user_id} is not the customer on this call. You can help only one customer per conversation.`,
      };
    }

    user.address = toAddress(args);
    return {
      user_id: user.user_id,
      address: user.address,
      message: `Default address updated to ${formatAddress(user.address)}. Existing orders keep their own shipping addresses.`,
    };
  },
  summary: (_args, result) =>
    "error" in result ? "profile address change failed" : `re-addressed ${result.user_id}`,
});
