import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { creditRefund, REFUND_DELAY_NOTE, REFUND_IMMEDIATE_NOTE } from "../refund.ts";
import { resolveOrder } from "../resolve.ts";
import { authenticatedUser, retailSlot, retailTool, setFocus } from "../store.ts";

/** tau2 accepts exactly these two. Anything else is refused. */
const CANCEL_REASONS = ["no longer needed", "ordered by mistake"] as const;

export const cancelPendingOrder = retailTool({
  name: "cancel_pending_order",
  description:
    "Cancel a pending order. Only an order whose status is exactly 'pending' can be cancelled — " +
    "check the status first. The reason must be either 'no longer needed' or 'ordered by mistake'. " +
    "State the order, its total and the refund destination to the caller and get an explicit yes " +
    "before calling this.",
  input: z.object({
    order_id: z
      .string()
      .max(120)
      .describe("Order id such as '#W0000000', or a spoken reference to one of their orders"),
    reason: z
      .enum(CANCEL_REASONS)
      .describe("Either 'no longer needed' or 'ordered by mistake' — no other reason is accepted"),
  }),
  // `run` before `summary`: TS infers the wrapper's generic `R` from
  // `run`'s return type, and processes object literal properties in
  // source order — with `summary` first, `result` in its signature can't be
  // inferred and silently falls back to `unknown`.
  run: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const user = authenticatedUser(state);
    if (isToolFailure(user)) return user;

    const order = resolveOrder(state, args.order_id);
    if (isToolFailure(order)) return order;
    setFocus(state, { orderId: order.order_id });

    if (order.status !== "pending") {
      return {
        error: `Order ${order.order_id} is ${order.status}, and only a pending order can be cancelled.`,
      };
    }
    // The enum makes this unreachable from a well-formed call; it stays because
    // the reason is the one field a caller supplies in free speech.
    if (!CANCEL_REASONS.includes(args.reason)) {
      return {
        error: `'${args.reason}' is not an accepted cancellation reason. It must be 'no longer needed' or 'ordered by mistake'.`,
      };
    }

    let immediate = false;
    const refunds = order.payment_history
      .filter((payment) => payment.transaction_type === "payment")
      .map((payment) => {
        const credited = creditRefund(user, payment.payment_method_id, payment.amount);
        immediate = immediate || credited.immediate;
        return {
          transaction_type: "refund" as const,
          amount: payment.amount,
          payment_method_id: payment.payment_method_id,
        };
      });

    order.status = "cancelled";
    order.cancel_reason = args.reason;
    order.payment_history.push(...refunds);

    const total = refunds.reduce((sum, refund) => sum + refund.amount, 0);
    return {
      order_id: order.order_id,
      status: order.status,
      cancel_reason: order.cancel_reason,
      refunded: total,
      refund_immediate: immediate,
      message: `Order ${order.order_id} is cancelled and $${total.toFixed(2)} is being refunded. ${
        immediate ? REFUND_IMMEDIATE_NOTE : REFUND_DELAY_NOTE
      }`,
    };
  },
  summary: (_args, result) =>
    "error" in result ? "cancel failed" : `cancelled ${result.order_id}`,
});
