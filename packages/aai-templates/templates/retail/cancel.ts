/**
 * Cancelling a pending order, as a PLAN and an APPLY.
 *
 * The split is what the confirmation gate is built out of, and it is the same
 * split in all seven mutating actions here: `plan*` validates everything and
 * computes the effect without touching the store, `apply*` performs it and
 * cannot fail. A staged plan is what the caller says yes to, so the validation
 * has to happen BEFORE the readback — a "yes" followed by a refusal is the one
 * sequence this gate exists to make impossible.
 */

import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { creditRefund, REFUND_DELAY_NOTE, REFUND_IMMEDIATE_NOTE } from "./refund.ts";
import { resolveOrder } from "./resolve.ts";
import type { RetailState } from "./shared.ts";
import { money } from "./store.ts";

/** The only two reasons the store records. */
export const CANCEL_REASONS = ["no longer needed", "ordered by mistake"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * A validated cancellation, holding only storable primitives.
 *
 * No `Order` or `PaymentMethod` reference: a plan is written into the session
 * slot and rides across turns, so a live object here would alias the store and
 * a persisted session could not carry it. Ids and amounts are enough, and
 * looking them up again at apply time is what keeps {@link applyCancel}
 * total.
 */
export interface CancelPlan {
  /** The sentence the agent reads back before asking for a yes. */
  readBack: string;
  orderId: string;
  reason: CancelReason;
  refunds: { methodId: string; amount: number }[];
  total: number;
}

export function planCancel(
  state: RetailState,
  spokenOrderId: string,
  reason: CancelReason,
): CancelPlan | ToolFailure {
  // No `authenticatedUser` gate here: `resolveOrder` opens with the identical
  // call and returns the identical failure, so a second one is a second store
  // lookup for a value this planner never reads.
  const order = resolveOrder(state, spokenOrderId);
  if (isToolFailure(order)) return order;

  // The enum makes this unreachable from a well-formed call; it stays because
  // the reason is the one field a caller supplies in free speech, and an LLM
  // tool call arrives untyped.
  if (!CANCEL_REASONS.includes(reason)) {
    return {
      error: `'${reason}' is not an accepted cancellation reason. It must be 'no longer needed' or 'ordered by mistake'.`,
    };
  }

  // Exactly 'pending'. A 'pending (item modified)' order has spent its one
  // modification and is past cancelling.
  if (order.status !== "pending") {
    return {
      error: `Order ${order.order_id} is ${order.status}, and only a pending order can be cancelled.`,
    };
  }

  const refunds = order.payment_history
    .filter((payment) => payment.transaction_type === "payment")
    .map((payment) => ({ methodId: payment.payment_method_id, amount: payment.amount }));
  const total = money(refunds.reduce((sum, refund) => sum + refund.amount, 0));

  const items = order.items.map((item) => item.name).join(", ");
  const destinations = [...new Set(refunds.map((refund) => refund.methodId))].join(" and ");
  return {
    readBack:
      `cancel order ${order.order_id} (${items}) as '${reason}' and refund ` +
      `${formatMoney(total)} to ${destinations}`,
    orderId: order.order_id,
    reason,
    refunds,
    total,
  };
}

/** The effect. Total by construction: every id in the plan was resolved from
 *  this same store, and nothing between staging and confirming can remove one. */
export function applyCancel(state: RetailState, plan: CancelPlan) {
  const order = state.store.orders[plan.orderId];
  const user = order ? state.store.users[order.user_id] : undefined;
  let immediate = false;

  if (order && user) {
    for (const refund of plan.refunds) {
      immediate = creditRefund(user, refund.methodId, refund.amount).immediate || immediate;
      order.payment_history.push({
        transaction_type: "refund",
        amount: refund.amount,
        payment_method_id: refund.methodId,
      });
    }
    order.status = "cancelled";
    order.cancel_reason = plan.reason;
  }

  return {
    order_id: plan.orderId,
    status: "cancelled" as const,
    cancel_reason: plan.reason,
    refunded: plan.total,
    refund_immediate: immediate,
    message: `Order ${plan.orderId} is cancelled and ${formatMoney(plan.total)} is being refunded. ${
      immediate ? REFUND_IMMEDIATE_NOTE : REFUND_DELAY_NOTE
    }`,
  };
}
