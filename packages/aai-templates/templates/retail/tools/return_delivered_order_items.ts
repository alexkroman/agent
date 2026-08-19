import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { OrderIdField, resolveOrder } from "../resolve.ts";
import {
  authenticatedUser,
  findPaymentMethod,
  isGiftCard,
  retailTool,
  setFocus,
} from "../store.ts";

export default retailTool({
  name: "return_delivered_order_items",
  description:
    "Request a return of items from a delivered order. Only a 'delivered' order can be returned, " +
    "and only once. The refund must go to the order's ORIGINAL payment method or to one of the " +
    "customer's gift cards. Confirm the exact item list and the refund destination with an " +
    "explicit yes before calling this. The customer gets an email explaining how to send the " +
    "items back.",
  inputSchema: z.object({
    order_id: OrderIdField,
    item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Item ids to return. May repeat if the order holds duplicates"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("Where the refund goes — the original method, or one of their gift cards"),
  }),
  execute: (args, state) => {
    const user = authenticatedUser(state);
    if (isToolFailure(user)) return user;

    const order = resolveOrder(state, args.order_id);
    if (isToolFailure(order)) return order;
    setFocus(state, { orderId: order.order_id });

    if (order.status !== "delivered") {
      return {
        error: `Order ${order.order_id} is ${order.status}. Only a delivered order can be returned, and only once.`,
      };
    }

    const method = findPaymentMethod(user, args.payment_method_id);
    if (isToolFailure(method)) return method;

    const originalMethodId = order.payment_history[0]?.payment_method_id;
    if (!isGiftCard(method) && args.payment_method_id !== originalMethodId) {
      return {
        error: `A refund must go to the original payment method (${originalMethodId}) or to a gift card. ${args.payment_method_id} is neither.`,
      };
    }

    if (args.item_ids.length === 0) {
      return { error: "No items were listed to return." };
    }
    const held = new Map<string, number>();
    for (const item of order.items) {
      held.set(item.item_id, (held.get(item.item_id) ?? 0) + 1);
    }
    const asked = new Map<string, number>();
    for (const itemId of args.item_ids) {
      asked.set(itemId, (asked.get(itemId) ?? 0) + 1);
    }
    for (const [itemId, count] of asked) {
      const available = held.get(itemId) ?? 0;
      if (count > available) {
        return {
          error: `Order ${order.order_id} holds ${available} of item ${itemId}, but ${count} were listed for return.`,
        };
      }
    }

    order.status = "return requested";
    order.return_items = [...args.item_ids].sort();
    order.return_payment_method_id = args.payment_method_id;

    const names = order.return_items
      .map((id) => order.items.find((item) => item.item_id === id)?.name ?? id)
      .join(", ");
    return {
      order_id: order.order_id,
      status: order.status,
      return_items: order.return_items,
      refund_to: args.payment_method_id,
      message: `Return requested on ${order.order_id} for ${names}. The customer will get an email with return instructions, and the refund goes to ${args.payment_method_id} once the items arrive.`,
    };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "return failed" : `return requested on ${result.order_id}`,
});
