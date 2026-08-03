import type { Order, OrderItem, RetailState, User, Variant } from "./shared.ts";
import {
  type ErrorResult,
  findPaymentMethod,
  findProduct,
  findVariant,
  isError,
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
 * Validate a proposed item swap and compute its price difference, without
 * mutating anything. Shared by `modify_pending_order_items` (pending, which
 * additionally forbids a no-op swap) and `exchange_delivered_order_items`
 * (delivered, which does not).
 *
 * Validation order matches tau2's so a bad call fails on the same check.
 */
export function planItemSwap(
  state: RetailState,
  order: Order,
  itemIds: string[],
  newItemIds: string[],
  opts: { requireDifferent: boolean },
): SwapPlan | ErrorResult {
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
    if (isError(product)) return product;

    const newVariant = findVariant(product, newItemId);
    if (isError(newVariant)) {
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

/**
 * Gate the price difference on the chosen payment method. Only a gift card has
 * a balance to run out of; a negative difference is a refund and never gated.
 */
export function assertCanCoverDiff(user: User, methodId: string, diff: number): ErrorResult | null {
  const method = findPaymentMethod(user, methodId);
  if (isError(method)) return method;
  if (isGiftCard(method) && method.balance < diff) {
    return {
      error: `Gift card ${methodId}'s balance ($${method.balance.toFixed(2)}) does not cover the $${diff.toFixed(2)} difference. Ask for another payment method.`,
    };
  }
  return null;
}

/** Apply a validated plan. Each line takes its OWN new variant's price, options
 *  and name — see the module note on tau2's leaked loop variable. */
export function applySwap(order: Order, plan: SwapPlan): void {
  for (const pair of plan.pairs) {
    const line = order.items[pair.index];
    if (!line) continue;
    line.item_id = pair.newVariant.item_id;
    line.price = pair.newVariant.price;
    line.options = pair.newVariant.options;
  }
}
