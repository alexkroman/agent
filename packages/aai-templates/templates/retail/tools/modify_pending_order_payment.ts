import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { resolveOrder } from "../resolve.ts";
import {
  authenticatedUser,
  findPaymentMethod,
  isGiftCard,
  money,
  retailSlot,
  retailTool,
  setFocus,
} from "../store.ts";

export const modifyPendingOrderPayment = retailTool({
  name: "modify_pending_order_payment",
  description:
    "Change which payment method a pending order is charged to. The new method must be different " +
    "from the current one, and a gift card must hold enough to cover the whole order. The original " +
    "method is refunded. Read the change back and get an explicit yes before calling this.",
  inputSchema: z.object({
    order_id: z
      .string()
      .max(120)
      .describe("Order id such as '#W0000000', or a spoken reference to one of their orders"),
    payment_method_id: z
      .string()
      .max(80)
      .describe("The new payment method id, e.g. 'gift_card_0000000'"),
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

    if (!order.status.startsWith("pending")) {
      return {
        error: `Order ${order.order_id} is ${order.status}, and only a pending order's payment method can be changed.`,
      };
    }

    const newMethod = findPaymentMethod(user, args.payment_method_id);
    if (isToolFailure(newMethod)) return newMethod;

    const original = order.payment_history[0];
    if (order.payment_history.length !== 1 || original?.transaction_type !== "payment") {
      return {
        error: `Order ${order.order_id} does not have exactly one payment on record, so its payment method cannot be changed.`,
      };
    }
    if (original.payment_method_id === args.payment_method_id) {
      return {
        error: `Order ${order.order_id} is already paid with ${args.payment_method_id}. The new method must be different.`,
      };
    }

    const amount = original.amount;
    if (isGiftCard(newMethod) && newMethod.balance < amount) {
      return {
        error: `Gift card ${args.payment_method_id}'s balance ($${newMethod.balance.toFixed(2)}) does not cover the $${amount.toFixed(2)} order total.`,
      };
    }

    order.payment_history.push(
      {
        transaction_type: "payment",
        amount,
        payment_method_id: args.payment_method_id,
      },
      {
        transaction_type: "refund",
        amount,
        payment_method_id: original.payment_method_id,
      },
    );

    if (isGiftCard(newMethod)) {
      newMethod.balance = money(newMethod.balance - amount);
    }
    const oldMethod = user.payment_methods[original.payment_method_id];
    if (oldMethod && isGiftCard(oldMethod)) {
      oldMethod.balance = money(oldMethod.balance + amount);
    }

    return {
      order_id: order.order_id,
      status: order.status,
      amount,
      paid_with: args.payment_method_id,
      refunded_to: original.payment_method_id,
      message: `Order ${order.order_id} is now charged to ${args.payment_method_id}, and $${amount.toFixed(2)} is going back to ${original.payment_method_id}.`,
    };
  },
  summary: (_args, result) =>
    "error" in result ? "payment change failed" : `re-paid ${result.order_id}`,
});
