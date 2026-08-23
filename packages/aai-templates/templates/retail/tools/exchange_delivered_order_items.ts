import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { OrderIdField, resolveOrder } from "../resolve.ts";
import { authenticatedUser, money, retailTool, setFocus } from "../store.ts";
import { assertCanCoverDiff, planItemSwap } from "../swap.ts";

export default retailTool({
  name: "exchange_delivered_order_items",
  when: "serving",
  description:
    "Request an exchange of items in a delivered order for different options of the SAME products. " +
    "Only a 'delivered' order can be exchanged, and only once. Remind the caller to name EVERY " +
    "item they want exchanged before you call this, read the whole list and the price difference " +
    "back, and get an explicit yes. No new order is needed — the customer gets an email explaining " +
    "how to send the originals back.",
  inputSchema: z.object({
    order_id: OrderIdField,
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
  execute: (args, state) => {
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
    // SORTED INDEPENDENTLY, verbatim from tau2 (`order.exchange_items =
    // sorted(item_ids)` / `sorted(new_item_ids)`, the same shape
    // `return_delivered_order_items` uses one list of) — kept because
    // `seed.json` is tau2's data and these fields are what a tau2 task's
    // expected end state is compared against. They are therefore two SETS of
    // ids, not a pairing: sorting each list separately permutes the second
    // against the first whenever the caller named more than one item.
    //
    // Which is why the ANSWER carries `exchanges` instead. `planItemSwap`
    // priced this positionally, so returning the two sorted lists as if they
    // lined up told the caller a pairing the quote was not for — the one thing
    // this result must not do, since the model reads it back down a phone.
    order.exchange_items = [...args.item_ids].sort();
    order.exchange_new_items = [...args.new_item_ids].sort();
    order.exchange_payment_method_id = args.payment_method_id;
    order.exchange_price_difference = plan.diff;

    return {
      order_id: order.order_id,
      status: order.status,
      price_difference: plan.diff,
      // The pairing AS PRICED, per line, in the order the caller gave it.
      exchanges: plan.pairs.map((pair) => ({
        item_id: pair.item.item_id,
        new_item_id: pair.newVariant.item_id,
        price_difference: money(pair.newVariant.price - pair.item.price),
      })),
      message:
        plan.diff > 0
          ? `Exchange requested on ${order.order_id}. $${plan.diff.toFixed(2)} will be charged to ${args.payment_method_id}. An email with return instructions is on its way.`
          : `Exchange requested on ${order.order_id}. $${Math.abs(plan.diff).toFixed(2)} will be refunded to ${args.payment_method_id}. An email with return instructions is on its way.`,
    };
  },
  summary: (_args, result) => `exchange requested on ${result.order_id}`,
});
