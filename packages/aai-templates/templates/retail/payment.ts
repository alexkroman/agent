/**
 * Changing which payment method a pending order is charged to, as a plan and an
 * apply (see `cancel.ts` for why every mutating action is split that way).
 */

import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { resolveOrder } from "./resolve.ts";
import type { RetailState } from "./shared.ts";
import { authenticatedUser, findPaymentMethod, isGiftCard, money } from "./store.ts";

export interface PaymentPlan {
  readBack: string;
  orderId: string;
  /** Where the order is charged after the change. */
  newMethodId: string;
  /** Where the original charge goes back to. */
  oldMethodId: string;
  amount: number;
}

export function planPayment(
  state: RetailState,
  spokenOrderId: string,
  newMethodId: string,
): PaymentPlan | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;

  const order = resolveOrder(state, spokenOrderId);
  if (isToolFailure(order)) return order;

  if (!order.status.startsWith("pending")) {
    return {
      error: `Order ${order.order_id} is ${order.status}, and only a pending order's payment method can be changed.`,
    };
  }

  const newMethod = findPaymentMethod(user, newMethodId);
  if (isToolFailure(newMethod)) return newMethod;

  const original = order.payment_history[0];
  if (order.payment_history.length !== 1 || original?.transaction_type !== "payment") {
    return {
      error: `Order ${order.order_id} does not have exactly one payment on record, so its payment method cannot be changed.`,
    };
  }
  if (original.payment_method_id === newMethodId) {
    return {
      error: `Order ${order.order_id} is already paid with ${newMethodId}. The new method must be different.`,
    };
  }

  const amount = original.amount;
  if (isGiftCard(newMethod) && newMethod.balance < amount) {
    return {
      error: `Gift card ${newMethodId}'s balance (${formatMoney(newMethod.balance)}) does not cover the ${formatMoney(amount)} order total.`,
    };
  }

  return {
    readBack:
      `charge order ${order.order_id} — ${formatMoney(amount)} — to ${newMethodId} instead, ` +
      `refunding ${original.payment_method_id}`,
    orderId: order.order_id,
    newMethodId,
    oldMethodId: original.payment_method_id,
    amount,
  };
}

export function applyPayment(state: RetailState, plan: PaymentPlan) {
  const order = state.store.orders[plan.orderId];
  const user = order ? state.store.users[order.user_id] : undefined;

  if (order && user) {
    order.payment_history.push(
      {
        transaction_type: "payment",
        amount: plan.amount,
        payment_method_id: plan.newMethodId,
      },
      {
        transaction_type: "refund",
        amount: plan.amount,
        payment_method_id: plan.oldMethodId,
      },
    );

    const newMethod = user.payment_methods[plan.newMethodId];
    if (newMethod && isGiftCard(newMethod)) {
      newMethod.balance = money(newMethod.balance - plan.amount);
    }
    const oldMethod = user.payment_methods[plan.oldMethodId];
    if (oldMethod && isGiftCard(oldMethod)) {
      oldMethod.balance = money(oldMethod.balance + plan.amount);
    }
  }

  return {
    order_id: plan.orderId,
    status: order?.status ?? "pending",
    amount: plan.amount,
    paid_with: plan.newMethodId,
    refunded_to: plan.oldMethodId,
    message: `Order ${plan.orderId} is now charged to ${plan.newMethodId}, and ${formatMoney(plan.amount)} is going back to ${plan.oldMethodId}.`,
  };
}
