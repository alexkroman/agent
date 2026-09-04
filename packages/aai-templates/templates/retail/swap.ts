/**
 * Swapping items for other options of the same product — the validation both
 * item changes share, and the two actions built on it (modifying a pending
 * order, exchanging a delivered one) as plan/apply pairs.
 *
 * See `cancel.ts` for why every mutating action is split that way.
 */

import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { resolveOrder } from "./resolve.ts";
import type { Order, OrderItem, RetailState, User, Variant } from "./shared.ts";
import {
  authenticatedUser,
  findPaymentMethod,
  findProduct,
  findVariant,
  isGiftCard,
  money,
} from "./store.ts";

export interface SwapPair {
  /** Index into `order.items`. Matching by index rather than by "first item
   *  with this id" is what makes duplicates independent of mutation order. */
  index: number;
  item: OrderItem;
  newVariant: Variant;
}

export interface SwapPlan {
  pairs: SwapPair[];
  /** Positive = the customer owes; negative = they are owed. Cents-rounded. */
  diff: number;
}

/**
 * One priced swap, flattened to primitives.
 *
 * A {@link SwapPair} holds live `OrderItem` and `Variant` references into the
 * store, which is right for a plan computed and applied inside one tool call
 * and wrong for one that waits in a session slot for the caller to say yes —
 * see `CancelPlan` in `cancel.ts`. This is the storable form, and it carries enough that
 * {@link applySwapLines} needs no lookup at all.
 */
export interface SwapLine {
  index: number;
  fromItemId: string;
  fromName: string;
  fromOptions: Record<string, string>;
  fromPrice: number;
  toItemId: string;
  toOptions: Record<string, string>;
  toPrice: number;
}

/**
 * Validate a proposed item swap and compute its price difference, without
 * mutating anything. Shared by the pending-order change (which additionally
 * forbids a no-op swap) and the delivered-order exchange (which does not).
 */
export function planItemSwap(
  state: RetailState,
  order: Order,
  itemIds: string[],
  newItemIds: string[],
  opts: { requireDifferent: boolean },
): SwapPlan | ToolFailure {
  if (itemIds.length === 0) {
    return { error: "No items were listed to change." };
  }
  if (itemIds.length !== newItemIds.length) {
    return {
      error: `Got ${itemIds.length} item(s) to change but ${newItemIds.length} replacement(s) — the lists must hold the same number, each replacement matching the item in the same position.`,
    };
  }

  // Duplicate-aware availability: an order holding one of an item cannot have
  // two of them changed.
  const heldCounts = new Map<string, number>();
  for (const item of order.items) {
    heldCounts.set(item.item_id, (heldCounts.get(item.item_id) ?? 0) + 1);
  }
  const askedCounts = new Map<string, number>();
  for (const itemId of itemIds) {
    askedCounts.set(itemId, (askedCounts.get(itemId) ?? 0) + 1);
  }
  for (const [itemId, asked] of askedCounts) {
    const held = heldCounts.get(itemId) ?? 0;
    if (asked > held) {
      return {
        error: `Order ${order.order_id} holds ${held} of item ${itemId}, but ${asked} were listed to change.`,
      };
    }
  }

  const consumed = new Set<number>();
  const pairs: SwapPair[] = [];
  let diff = 0;

  for (const [position, itemId] of itemIds.entries()) {
    const newItemId = newItemIds[position];
    if (!newItemId) {
      return { error: `No replacement was given for item ${itemId}.` };
    }
    if (opts.requireDifferent && newItemId === itemId) {
      return {
        error: `Item ${itemId} was listed as its own replacement. Pick a different option of the same product, or leave it out.`,
      };
    }

    const index = order.items.findIndex((item, i) => item.item_id === itemId && !consumed.has(i));
    const item = order.items[index];
    if (index === -1 || !item) {
      return { error: `Item ${itemId} is not in order ${order.order_id}.` };
    }
    consumed.add(index);

    const product = findProduct(state, item.product_id);
    if (isToolFailure(product)) return product;

    const newVariant = findVariant(product, newItemId);
    if (isToolFailure(newVariant)) {
      return {
        error: `${newItemId} is not an option of ${product.name} (${product.product_id}). An item can only be changed to a different option of the same product — you cannot change a ${product.name} into something else.`,
      };
    }
    if (!newVariant.available) {
      return {
        error: `${product.name} option ${newItemId} (${Object.values(newVariant.options).join(", ")}) is not available.`,
      };
    }

    diff += newVariant.price - item.price;
    pairs.push({ index, item, newVariant });
  }

  return { pairs, diff: money(diff) };
}

/** Flatten a freshly-computed plan into the form a staged action can hold. */
export function toSwapLines(plan: SwapPlan): SwapLine[] {
  return plan.pairs.map((pair) => ({
    index: pair.index,
    fromItemId: pair.item.item_id,
    fromName: pair.item.name,
    fromOptions: { ...pair.item.options },
    fromPrice: pair.item.price,
    toItemId: pair.newVariant.item_id,
    toOptions: { ...pair.newVariant.options },
    toPrice: pair.newVariant.price,
  }));
}

/**
 * Gate the price difference on the chosen payment method. Only a gift card has
 * a balance to run out of; a negative difference is a refund and never gated.
 */
export function assertCanCoverDiff(user: User, methodId: string, diff: number): ToolFailure | null {
  const method = findPaymentMethod(user, methodId);
  if (isToolFailure(method)) return method;
  if (isGiftCard(method) && method.balance < diff) {
    return {
      error: `Gift card ${methodId}'s balance (${formatMoney(method.balance)}) does not cover the ${formatMoney(diff)} difference. Ask for another payment method.`,
    };
  }
  return null;
}

/** Apply validated lines. Each takes its OWN new option's price and options —
 *  see the module note on tau2's leaked loop variable. */
export function applySwapLines(order: Order, lines: readonly SwapLine[]): void {
  for (const line of lines) {
    const item = order.items[line.index];
    if (!item) continue;
    item.item_id = line.toItemId;
    item.price = line.toPrice;
    item.options = { ...line.toOptions };
  }
}

/** "the glass 2 litre one for the stainless steel 1 litre one" — how a swap is
 *  said out loud. Item numbers are never in it; the prompt forbids reading one. */
function describeLine(line: SwapLine): string {
  const from = Object.values(line.fromOptions).join(" ");
  const to = Object.values(line.toOptions).join(" ");
  return `the ${from} ${line.fromName} for the ${to} one`;
}

function describeDiff(diff: number, methodId: string): string {
  if (diff > 0) return `${formatMoney(diff)} charged to ${methodId}`;
  if (diff < 0) return `${formatMoney(Math.abs(diff))} refunded to ${methodId}`;
  return "no price difference";
}

// ─── Changing the items in a pending order ───────────────────────────────────

export interface ModifyItemsPlan {
  readBack: string;
  orderId: string;
  lines: SwapLine[];
  diff: number;
  paymentMethodId: string;
}

export function planModifyItems(
  state: RetailState,
  spokenOrderId: string,
  itemIds: string[],
  newItemIds: string[],
  paymentMethodId: string,
): ModifyItemsPlan | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;

  const order = resolveOrder(state, spokenOrderId);
  if (isToolFailure(order)) return order;

  // Exactly 'pending'. A 'pending (item modified)' order has already used its
  // one modification, which is what makes this action terminal.
  if (order.status !== "pending") {
    return {
      error: `Order ${order.order_id} is ${order.status}. Items can only be changed while an order is exactly 'pending', and only once.`,
    };
  }

  const plan = planItemSwap(state, order, itemIds, newItemIds, { requireDifferent: true });
  if (isToolFailure(plan)) return plan;

  const blocked = assertCanCoverDiff(user, paymentMethodId, plan.diff);
  if (blocked) return blocked;

  const lines = toSwapLines(plan);
  return {
    readBack:
      `swap ${lines.map(describeLine).join(", and ")} on order ${order.order_id}, ` +
      `with ${describeDiff(plan.diff, paymentMethodId)} — and this is the ONE change that order ` +
      "allows: after it, it can no longer be cancelled or modified by anyone",
    orderId: order.order_id,
    lines,
    diff: plan.diff,
    paymentMethodId,
  };
}

export function applyModifyItems(state: RetailState, plan: ModifyItemsPlan) {
  const order = state.store.orders[plan.orderId];
  const user = order ? state.store.users[order.user_id] : undefined;

  if (order && user) {
    const method = user.payment_methods[plan.paymentMethodId];
    if (method && isGiftCard(method)) {
      method.balance = money(method.balance - plan.diff);
    }
    order.payment_history.push({
      transaction_type: plan.diff > 0 ? "payment" : "refund",
      amount: money(Math.abs(plan.diff)),
      payment_method_id: plan.paymentMethodId,
    });
    applySwapLines(order, plan.lines);
    order.status = "pending (item modified)";
  }

  return {
    order_id: plan.orderId,
    status: "pending (item modified)" as const,
    price_difference: plan.diff,
    items: (order?.items ?? []).map((item) => ({
      name: item.name,
      item_id: item.item_id,
      options: item.options,
      price: item.price,
    })),
    message:
      plan.diff > 0
        ? `Done. ${formatMoney(plan.diff)} was charged to ${plan.paymentMethodId}. This order can no longer be modified or cancelled.`
        : `Done. ${formatMoney(Math.abs(plan.diff))} is being refunded to ${plan.paymentMethodId}. This order can no longer be modified or cancelled.`,
  };
}

// ─── Exchanging a delivered order ────────────────────────────────────────────

export interface ExchangePlan {
  readBack: string;
  orderId: string;
  lines: SwapLine[];
  diff: number;
  paymentMethodId: string;
}

export function planExchange(
  state: RetailState,
  spokenOrderId: string,
  itemIds: string[],
  newItemIds: string[],
  paymentMethodId: string,
): ExchangePlan | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;

  const order = resolveOrder(state, spokenOrderId);
  if (isToolFailure(order)) return order;

  if (order.status !== "delivered") {
    return {
      error: `Order ${order.order_id} is ${order.status}. Only a delivered order can be exchanged, and only once.`,
    };
  }

  // requireDifferent is false: a zero-difference line is harmless on a
  // delivered order, and refusing one would reject a caller who listed every
  // item and changed their mind about only some.
  const plan = planItemSwap(state, order, itemIds, newItemIds, { requireDifferent: false });
  if (isToolFailure(plan)) return plan;

  const blocked = assertCanCoverDiff(user, paymentMethodId, plan.diff);
  if (blocked) return blocked;

  const lines = toSwapLines(plan);
  return {
    readBack:
      `exchange ${lines.map(describeLine).join(", and ")} on order ${order.order_id}, ` +
      `with ${describeDiff(plan.diff, paymentMethodId)}`,
    orderId: order.order_id,
    lines,
    diff: plan.diff,
    paymentMethodId,
  };
}

export function applyExchange(state: RetailState, plan: ExchangePlan) {
  const order = state.store.orders[plan.orderId];

  // The pairing AS PRICED, in the order the caller gave it. tau2 stored these
  // as two INDEPENDENTLY SORTED lists, which permuted the second against the
  // first whenever more than one item was named — two sets, not a pairing, and
  // the result had to carry the real pairing separately to avoid telling the
  // caller a quote that was not the one they got. Nothing here is compared
  // against a tau2 end state any more, so the fields hold the pairing itself.
  if (order) {
    order.status = "exchange requested";
    order.exchange_items = plan.lines.map((line) => line.fromItemId);
    order.exchange_new_items = plan.lines.map((line) => line.toItemId);
    order.exchange_payment_method_id = plan.paymentMethodId;
    order.exchange_price_difference = plan.diff;
  }

  return {
    order_id: plan.orderId,
    status: "exchange requested" as const,
    price_difference: plan.diff,
    exchanges: plan.lines.map((line) => ({
      item_id: line.fromItemId,
      new_item_id: line.toItemId,
      price_difference: money(line.toPrice - line.fromPrice),
    })),
    message:
      plan.diff > 0
        ? `Exchange requested on ${plan.orderId}. ${formatMoney(plan.diff)} will be charged to ${plan.paymentMethodId}. An email with return instructions is on its way.`
        : `Exchange requested on ${plan.orderId}. ${formatMoney(Math.abs(plan.diff))} will be refunded to ${plan.paymentMethodId}. An email with return instructions is on its way.`,
  };
}
