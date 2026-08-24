/**
 * Returning items from a delivered order, as a plan and an apply (see
 * `cancel.ts` for why every mutating action is split that way).
 */

import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
import { resolveOrder } from "./resolve.ts";
import type { RetailState } from "./shared.ts";
import { authenticatedUser, findPaymentMethod, isGiftCard } from "./store.ts";

export interface ReturnPlan {
  readBack: string;
  orderId: string;
  /** In the order the caller named them — duplicates are meaningful. */
  itemIds: string[];
  /** Item names, positionally aligned with `itemIds`, so the readback and the
   *  result can name things rather than read ten-digit numbers aloud. */
  itemNames: string[];
  paymentMethodId: string;
}

export function planReturn(
  state: RetailState,
  spokenOrderId: string,
  itemIds: string[],
  paymentMethodId: string,
): ReturnPlan | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;

  const order = resolveOrder(state, spokenOrderId);
  if (isToolFailure(order)) return order;

  if (order.status !== "delivered") {
    return {
      error: `Order ${order.order_id} is ${order.status}. Only a delivered order can be returned, and only once.`,
    };
  }

  const method = findPaymentMethod(user, paymentMethodId);
  if (isToolFailure(method)) return method;

  const originalMethodId = order.payment_history[0]?.payment_method_id;
  if (!isGiftCard(method) && paymentMethodId !== originalMethodId) {
    return {
      error: `A refund must go to the original payment method (${originalMethodId}) or to a gift card. ${paymentMethodId} is neither.`,
    };
  }

  if (itemIds.length === 0) {
    return { error: "No items were listed to return." };
  }
  const held = new Map<string, number>();
  for (const item of order.items) {
    held.set(item.item_id, (held.get(item.item_id) ?? 0) + 1);
  }
  const asked = new Map<string, number>();
  for (const itemId of itemIds) {
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

  const itemNames = itemIds.map(
    (id) => order.items.find((item) => item.item_id === id)?.name ?? id,
  );
  return {
    readBack:
      `return ${itemNames.join(", ")} from order ${order.order_id}, ` +
      `with the refund going to ${paymentMethodId}`,
    orderId: order.order_id,
    itemIds: [...itemIds],
    itemNames,
    paymentMethodId,
  };
}

export function applyReturn(state: RetailState, plan: ReturnPlan) {
  const order = state.store.orders[plan.orderId];

  // In the order the caller named them, not sorted: tau2 sorted this list to
  // match an expected end state, and nothing compares against one any more.
  if (order) {
    order.status = "return requested";
    order.return_items = [...plan.itemIds];
    order.return_payment_method_id = plan.paymentMethodId;
  }

  return {
    order_id: plan.orderId,
    status: "return requested" as const,
    return_items: plan.itemIds,
    refund_to: plan.paymentMethodId,
    message: `Return requested on ${plan.orderId} for ${plan.itemNames.join(", ")}. The customer will get an email with return instructions, and the refund goes to ${plan.paymentMethodId} once the items arrive.`,
  };
}
