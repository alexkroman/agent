import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { resolveOrder } from "../resolve.ts";
import {
  authenticatedUser,
  isGiftCard,
  money,
  retailSlot,
  retailTool,
  setFocus,
} from "../store.ts";
import { applySwap, assertCanCoverDiff, planItemSwap } from "../swap.ts";

export const modifyPendingOrderItems = retailTool({
  name: "modify_pending_order_items",
  description:
    "Change items in a pending order to different options of the SAME products. This can be done " +
    "ONCE per order and is irreversible — afterwards the order can no longer be cancelled or " +
    "modified at all. Collect EVERY item the caller wants changed into one call, read the whole " +
    "list and the price difference back, and get an explicit yes first. The item and replacement " +
    "lists are positional and must be the same length.",
  inputSchema: z.object({
    order_id: z
      .string()
      .max(120)
      .describe("Order id such as '#W0000000', or a spoken reference to one of their orders"),
    item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Item ids to change. May repeat if the order holds duplicates"),
    new_item_ids: z
      .array(z.string().max(60))
      .max(20)
      .describe("Replacement item ids, each matching the item in the same position"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("Method to charge or refund the price difference, e.g. 'gift_card_0000000'"),
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

    // Exactly 'pending'. A 'pending (item modified)' order has already used its
    // one modification, which is what makes this action terminal.
    if (order.status !== "pending") {
      return {
        error: `Order ${order.order_id} is ${order.status}. Items can only be changed while an order is exactly 'pending', and only once.`,
      };
    }

    const plan = planItemSwap(state, order, args.item_ids, args.new_item_ids, {
      requireDifferent: true,
    });
    if (isToolFailure(plan)) return plan;

    const blocked = assertCanCoverDiff(user, args.payment_method_id, plan.diff);
    if (blocked) return blocked;

    const method = user.payment_methods[args.payment_method_id];
    if (method && isGiftCard(method)) {
      method.balance = money(method.balance - plan.diff);
    }
    order.payment_history.push({
      transaction_type: plan.diff > 0 ? "payment" : "refund",
      amount: money(Math.abs(plan.diff)),
      payment_method_id: args.payment_method_id,
    });

    applySwap(order, plan);
    order.status = "pending (item modified)";

    return {
      order_id: order.order_id,
      status: order.status,
      price_difference: plan.diff,
      items: order.items.map((item) => ({
        name: item.name,
        item_id: item.item_id,
        options: item.options,
        price: item.price,
      })),
      message:
        plan.diff > 0
          ? `Done. $${plan.diff.toFixed(2)} was charged to ${args.payment_method_id}. This order can no longer be modified or cancelled.`
          : `Done. $${Math.abs(plan.diff).toFixed(2)} is being refunded to ${args.payment_method_id}. This order can no longer be modified or cancelled.`,
    };
  },
  summary: (_args, result) =>
    isToolFailure(result)
      ? "item change failed"
      : `modified ${result.order_id} (${result.price_difference >= 0 ? "+" : ""}${result.price_difference})`,
});
