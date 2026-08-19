/**
 * Spoken references to this store's things.
 *
 * The generic half — reading digits out of an utterance, reading a position out
 * of one, and the never-guess contract that turns a list of candidates into one
 * of them or into a failure that lists them — is `resolveOne`, `spokenDigits`
 * and `spokenOrdinal` (`@alexkroman1/aai`). What stays here is the STORE's
 * vocabulary: what an order id looks like when a caller reads it aloud, which
 * words name a status, and what a variant's options are matched against.
 */

import { isToolFailure, resolveOne, spokenDigits, type ToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import type { Order, OrderStatus, Product, RetailState } from "./shared.ts";
import { authenticatedUser } from "./store.ts";

/**
 * The `order_id` parameter, for the seven tools that take one.
 *
 * Same reasoning as `AddressFields` in `address.ts`, and here the stakes are the
 * DESCRIPTION: it is the sentence that tells the model a spoken reference is
 * acceptable, so a copy that lost the second half would quietly make one tool
 * demand a literal id while its six siblings accept "the last one". It belongs in
 * this module because "what an order id looks like when a caller reads it aloud"
 * is exactly what {@link resolveOrder} implements.
 */
export const OrderIdField = z
  .string()
  .max(120)
  .describe("Order id such as '#W0000000', or a spoken reference to one of their orders");

/** `#W5866402` from anything STT plausibly produces for it. */
export function normalizeOrderId(spoken: string): string {
  const compact = spoken.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `#W${compact.replace(/^W/, "")}`;
}

/** Item ids are 10 digits; callers read them in groups. */
export function normalizeItemId(spoken: string): string {
  return spokenDigits(spoken);
}

/** A digit run long enough to be an id rather than an ordinal. */
const LOOKS_LIKE_ORDER_ID = /\d[\d\s-]{5,}/;
const LOOKS_LIKE_ITEM_ID = /(?:\d[\s-]*){8,}/;

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

  // The empty case is the store's to answer, not `resolveOne`'s: "no cancelled
  // order" is only useful said alongside the statuses this customer DOES have,
  // which is what lets the model ask its next question without another tool call.
  if (candidates.length === 0) {
    const have = [...new Set(owned.map((o) => o.status))].join(", ");
    return {
      error: `This customer has no ${statusEntry?.[0] ?? "matching"} order. They have: ${have}.`,
    };
  }

  // A position, then exactly-one, then an ambiguity that lists them — and never
  // a guess, because the consequence here is cancelling the wrong order.
  return resolveOne(candidates, spoken, { label: "order", describe: describeOrder });
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

  const pool = Object.values(product.variants).filter((v) => !opts.availableOnly || v.available);

  // A variant is named by its OPTIONS ("the blue medium"), so the score is how
  // many of them the caller said. Everything after that — no match, one match, a
  // tie — is `resolveOne`'s, and a tie is answered rather than broken.
  const picked = resolveOne(pool, spoken, {
    label: `${product.name} option`,
    describe: (v) => `${v.item_id} (${Object.values(v.options).join(", ")})`,
    score: (variant, text) =>
      Object.values(variant.options).filter((value) => text.includes(value.toLowerCase())).length,
  });
  return isToolFailure(picked) ? picked : picked.item_id;
}
