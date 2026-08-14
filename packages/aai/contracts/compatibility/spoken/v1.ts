// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `spoken` epoch 1.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. What this pins beyond the signatures is the RETURN UNION: every one
 * of these functions is written at a call site that has to handle the failure
 * arm, so narrowing it away is a break this file reports.
 */

import { type ResolveOneOptions, resolveOne, spokenDigits, spokenOrdinal } from "../../../index.ts";
import { isToolFailure, type ToolFailure } from "../../../sdk/utils.ts";

type Order = { id: string; status: string };

/** Digits out of a read-aloud id. */
export function orderIdFrom(spoken: string): string {
  return `#W${spokenDigits(spoken)}`;
}

/** A position, or none — `-1` is the last one. */
export function positionFrom(spoken: string): number | undefined {
  return spokenOrdinal(spoken);
}

/** The options object, named — a wrapper that supplies its own describe. */
export function orderOptions(): ResolveOneOptions<Order> {
  return {
    label: "order",
    describe: (order) => `${order.id} (${order.status})`,
  };
}

/** The whole contract: one of them, or a failure that lists them. */
export function pickOrder(orders: readonly Order[], spoken: string): Order | ToolFailure {
  return resolveOne(orders, spoken, orderOptions());
}

/** A failure PROPAGATES — the caller forwards it rather than rewording it. */
export function pickOrderId(orders: readonly Order[], spoken: string): string | ToolFailure {
  const picked = pickOrder(orders, spoken);
  if (isToolFailure(picked)) return picked;
  return picked.id;
}

/** The scored form: a candidate matched on what the caller said about it. */
export function pickByColor(
  items: readonly { id: string; color: string }[],
  spoken: string,
): { id: string; color: string } | ToolFailure {
  return resolveOne(items, spoken, {
    label: "item",
    describe: (item) => `${item.id} (${item.color})`,
    score: (item, text) => (text.includes(item.color) ? 1 : 0),
  });
}
