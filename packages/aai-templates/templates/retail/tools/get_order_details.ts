import { isToolFailure, omitUndefined } from "@alexkroman1/aai";
import { z } from "zod";
import { OrderIdField, resolveOrder } from "../resolve.ts";
import { retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "get_order_details",
  when: "serving",
  description:
    "Get the status and full details of one of the authenticated customer's orders. Accepts the " +
    "order id (e.g. '#W0000000' — note the leading '#'), or a spoken reference such as " +
    "'my pending order', 'the delivered one', or 'the second pending order'.",
  inputSchema: z.object({
    order_id: OrderIdField,
  }),
  execute: (args, state) => {
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
      ...omitUndefined({ fulfillments: order.fulfillments }),
      ...(order.cancel_reason ? { cancel_reason: order.cancel_reason } : {}),
    };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "order read failed" : `read ${result.order_id}`,
});
