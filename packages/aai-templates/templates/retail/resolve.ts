import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
import type { Order, OrderStatus, Product, RetailState } from "./shared.ts";
import { authenticatedUser } from "./store.ts";

/** `#W5866402` from anything STT plausibly produces for it. */
export function normalizeOrderId(spoken: string): string {
  const compact = spoken.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `#W${compact.replace(/^W/, "")}`;
}

/** Item ids are 10 digits; callers read them in groups. */
export function normalizeItemId(spoken: string): string {
  return spoken.replace(/\D/g, "");
}

/** A digit run long enough to be an id rather than an ordinal. */
const LOOKS_LIKE_ORDER_ID = /\d[\d\s-]{5,}/;
const LOOKS_LIKE_ITEM_ID = /(?:\d[\s-]*){8,}/;

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
  last: -1,
};

/** Spoken status words → the statuses they select. `pending` deliberately
 *  excludes `pending (item modified)`, which no tool will accept anyway. */
const STATUS_WORDS: [string, OrderStatus[]][] = [
  ["delivered", ["delivered"]],
  ["pending", ["pending"]],
  ["processed", ["processed"]],
  ["cancelled", ["cancelled"]],
  ["canceled", ["cancelled"]],
  ["returned", ["return requested"]],
  ["exchanged", ["exchange requested"]],
];

function describeOrder(order: Order): string {
  const items = order.items.map((i) => i.name).join(", ");
  return `${order.order_id} (${order.status}: ${items})`;
}

/**
 * Resolve a spoken order reference against the authenticated customer's orders.
 *
 * Ambiguity is always an error listing the candidates, never a guess — the
 * consequence of guessing here is cancelling the wrong order.
 */
export function resolveOrder(state: RetailState, spoken: string): Order | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;

  const owned = user.orders
    .map((id) => state.store.orders[id])
    .filter((o): o is Order => o !== undefined);

  if (LOOKS_LIKE_ORDER_ID.test(spoken)) {
    const orderId = normalizeOrderId(spoken);
    const match = owned.find((o) => o.order_id === orderId);
    return match ?? { error: `Order ${orderId} was not found on this customer's account.` };
  }

  const text = spoken.toLowerCase();
  const statusEntry = STATUS_WORDS.find(([word]) => text.includes(word));
  const candidates = statusEntry ? owned.filter((o) => statusEntry[1].includes(o.status)) : owned;

  if (candidates.length === 0) {
    const have = [...new Set(owned.map((o) => o.status))].join(", ");
    return {
      error: `This customer has no ${statusEntry?.[0] ?? "matching"} order. They have: ${have}.`,
    };
  }

  const ordinalWord = Object.keys(ORDINALS).find((word) => new RegExp(`\\b${word}\\b`).test(text));
  if (ordinalWord) {
    const index = ORDINALS[ordinalWord] ?? 0;
    const picked = index === -1 ? candidates.at(-1) : candidates[index];
    if (!picked) {
      return {
        error: `There is no ${ordinalWord} such order — the customer has ${candidates.length}: ${candidates
          .map(describeOrder)
          .join("; ")}.`,
      };
    }
    return picked;
  }

  const only = candidates[0];
  if (candidates.length === 1 && only) return only;

  return {
    error: `That is ambiguous — ${candidates.length} orders match. Ask which one: ${candidates
      .map(describeOrder)
      .join("; ")}.`,
  };
}

/**
 * Resolve a spoken variant reference within one product: a 10-digit item id, or
 * an option phrase like "the blue medium".
 */
export function resolveVariantId(
  product: Product,
  spoken: string,
  opts: { availableOnly?: boolean } = {},
): string | ToolFailure {
  if (LOOKS_LIKE_ITEM_ID.test(spoken)) {
    const itemId = normalizeItemId(spoken);
    const variant = product.variants[itemId];
    if (!variant) {
      return {
        error: `Item ${itemId} is not a variant of ${product.name} (${product.product_id}). Its variants are: ${Object.values(
          product.variants,
        )
          .map((v) => `${v.item_id} (${Object.values(v.options).join(", ")})`)
          .join("; ")}.`,
      };
    }
    return itemId;
  }

  const text = spoken.toLowerCase();
  const pool = Object.values(product.variants).filter((v) => !opts.availableOnly || v.available);

  let best = 0;
  const scored = pool.map((variant) => {
    const score = Object.values(variant.options).filter((value) =>
      text.includes(value.toLowerCase()),
    ).length;
    best = Math.max(best, score);
    return { variant, score };
  });

  if (best === 0) {
    return {
      error: `No ${product.name} option matches "${spoken}". Options available: ${pool
        .map((v) => `${v.item_id} (${Object.values(v.options).join(", ")})`)
        .join("; ")}.`,
    };
  }

  const winners = scored.filter((s) => s.score === best);
  const winner = winners[0]?.variant;
  if (winners.length === 1 && winner) return winner.item_id;

  return {
    error: `"${spoken}" matches ${winners.length} ${product.name} options. Ask which: ${winners
      .map((s) => `${s.variant.item_id} (${Object.values(s.variant.options).join(", ")})`)
      .join("; ")}.`,
  };
}
