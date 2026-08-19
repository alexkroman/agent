import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { AddressFields, formatAddress, toAddress } from "../address.ts";
import { OrderIdField, resolveOrder } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "modify_pending_order_address",
  description:
    "Change the shipping address of a pending order. Read the new address back to the caller and " +
    "get an explicit yes before calling this. This does not change the customer's default address.",
  inputSchema: z.object({
    order_id: OrderIdField,
    ...AddressFields,
  }),
  execute: (args, state) => {
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
    isToolFailure(result) ? "address change failed" : `re-addressed ${result.order_id}`,
});
