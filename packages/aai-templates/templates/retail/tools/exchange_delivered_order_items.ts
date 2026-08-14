import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { resolveOrder } from "../resolve.ts";
import { authenticatedUser, retailSlot, retailTool, setFocus } from "../store.ts";
import { assertCanCoverDiff, planItemSwap } from "../swap.ts";

export default retailTool({
  name: "exchange_delivered_order_items",
  description:
    "Request an exchange of items in a delivered order for different options of the SAME products. " +
    "Only a 'delivered' order can be exchanged, and only once. Remind the caller to name EVERY " +
    "item they want exchanged before you call this, read the whole list and the price difference " +
    "back, and get an explicit yes. No new order is needed — the customer gets an email explaining " +
    "how to send the originals back.",
  inputSchema: z.object({
    order_id: z
      .string()
      .max(120)
      .describe("Order id such as '#W0000000', or a spoken reference to one of their orders"),
    item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Item ids to exchange. May repeat if the order holds duplicates"),
    new_item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Replacement item ids, each matching the item in the same position"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("Method to charge or refund the price difference"),
  }),
  // `execute` before `summary`: TS infers the wrapper's generic `R` from
  // `execute`'s return type, and processes object literal properties in
  // source order — with `summary` first, `result` in its signature can't be
  // inferred and silently falls back to `unknown`.
  execute: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const user = authenticatedUser(state);
    if (isToolFailure(user)) return user;

    const order = resolveOrder(state, args.order_id);
    if (isToolFailure(order)) return order;
    setFocus(state, { orderId: order.order_id });

    if (order.status !== "delivered") {
      return {
        error: `Order ${order.order_id} is ${order.status}. Only a delivered order can be exchanged, and only once.`,
      };
    }

    // requireDifferent is false: tau2 permits a same-item entry here, and a
    // zero-difference exchange is harmless on a delivered order.
    const plan = planItemSwap(state, order, args.item_ids, args.new_item_ids, {
      requireDifferent: false,
    });
    if (isToolFailure(plan)) return plan;

    const blocked = assertCanCoverDiff(user, args.payment_method_id, plan.diff);
    if (blocked) return blocked;

    // No balance moves and no items change: this records a REQUEST. The money
    // and the item swap settle when the originals come back.
    order.status = "exchange requested";
    order.exchange_items = [...args.item_ids].sort();
    order.exchange_new_items = [...args.new_item_ids].sort();
    order.exchange_payment_method_id = args.payment_method_id;
    order.exchange_price_difference = plan.diff;

    return {
      order_id: order.order_id,
      status: order.status,
      price_difference: plan.diff,
      exchange_items: order.exchange_items,
      exchange_new_items: order.exchange_new_items,
      message:
        plan.diff > 0
          ? `Exchange requested on ${order.order_id}. $${plan.diff.toFixed(2)} will be charged to ${args.payment_method_id}. An email with return instructions is on its way.`
          : `Exchange requested on ${order.order_id}. $${Math.abs(plan.diff).toFixed(2)} will be refunded to ${args.payment_method_id}. An email with return instructions is on its way.`,
    };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "exchange failed" : `exchange requested on ${result.order_id}`,
});
