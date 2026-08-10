import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AddressFields, formatAddress, toAddress } from "../address.ts";
import { resolveOrder } from "../resolve.ts";
import { retailSlot, retailTool, setFocus } from "../store.ts";

export const modifyPendingOrderAddress = retailTool({
  name: "modify_pending_order_address",
  description:
    "Change the shipping address of a pending order. Read the new address back to the caller and " +
    "get an explicit yes before calling this. This does not change the customer's default address.",
  inputSchema: z.object({
    order_id: z
      .string()
      .max(120)
      .describe("Order id such as '#W0000000', or a spoken reference to one of their orders"),
    ...AddressFields,
  }),
  // `execute` before `summary`: TS infers the wrapper's generic `R` from
  // `execute`'s return type, and processes object literal properties in
  // source order — with `summary` first, `result` in its signature can't be
  // inferred and silently falls back to `unknown`.
  execute: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const order = resolveOrder(state, args.order_id);
    if (isToolFailure(order)) return order;
    setFocus(state, { orderId: order.order_id });

    // Any pending variant is fine here — unlike cancel and modify-items, which
    // require exactly 'pending'. Re-addressing a modified order is harmless.
    if (!order.status.startsWith("pending")) {
      return {
        error: `Order ${order.order_id} is ${order.status}, and only a pending order's address can be changed.`,
      };
    }

    order.address = toAddress(args);
    return {
      order_id: order.order_id,
      status: order.status,
      address: order.address,
      message: `Order ${order.order_id} now ships to ${formatAddress(order.address)}.`,
    };
  },
  summary: (_args, result) =>
    "error" in result ? "address change failed" : `re-addressed ${result.order_id}`,
});
