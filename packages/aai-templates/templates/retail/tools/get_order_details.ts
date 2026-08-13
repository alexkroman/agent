import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { resolveOrder } from "../resolve.ts";
import { retailSlot, retailTool, setFocus } from "../store.ts";

export const getOrderDetails = retailTool({
  name: "get_order_details",
  description:
    "Get the status and full details of one of the authenticated customer's orders. Accepts the " +
    "order id (e.g. '#W0000000' — note the leading '#'), or a spoken reference such as " +
    "'my pending order', 'the delivered one', or 'the second pending order'.",
  inputSchema: z.object({
    order_id: z
      .string()
      .max(120)
      .describe("Order id such as '#W0000000', or a spoken reference to one of their orders"),
  }),
  // `execute` before `summary`: see find_user_id_by_email.ts for why the order
  // is load-bearing for the generic `result` type in `summary`.
  execute: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const order = resolveOrder(state, args.order_id);
    if (isToolFailure(order)) return order;
    setFocus(state, { orderId: order.order_id });
    return {
      order_id: order.order_id,
      status: order.status,
      address: order.address,
      items: order.items.map((item) => ({
        name: item.name,
        product_id: item.product_id,
        item_id: item.item_id,
        price: item.price,
        options: item.options,
      })),
      payment_history: order.payment_history,
      ...(order.fulfillments ? { fulfillments: order.fulfillments } : {}),
      ...(order.cancel_reason ? { cancel_reason: order.cancel_reason } : {}),
    };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "order read failed" : `read ${result.order_id}`,
});
