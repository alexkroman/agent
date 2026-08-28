// Copyright 2026 the AAI authors. MIT license.
/**
 * FROZEN authoring example — `aai:state`, epoch 4.
 *
 * Moved with the `AgentParams` split. The slot surface is unchanged and epoch 4
 * is RETAINED: this is how session state was declared, read, updated and
 * projected to the browser.
 */

import { z } from "zod";
import {
  type DeepReadonly,
  type SessionSlot,
  type StateProjection,
  sessionSlot,
} from "../../../index.ts";

type Order = { items: string[]; total: number };

/** The slot, typed by its factory with no annotation. */
export const orderSlot: SessionSlot<"order", Order> = sessionSlot(
  "order",
  (): Order => ({ items: [], total: 0 }),
);

/** A frozen read — the alias every template writes. */
export type FrozenOrder = DeepReadonly<Order>;

export function summarize(order: FrozenOrder): string {
  return `${order.items.length} item(s), ${order.total}`;
}

/** The synchronous update window, through `updateTool`. */
export const addItem = orderSlot.updateTool({
  description: "Add an item to the order",
  inputSchema: z.object({ sku: z.string(), price: z.number() }),
  execute: ({ sku, price }, order) => {
    order.items.push(sku);
    order.total += price;
    return { items: order.items.length };
  },
});

/** The projection an agent hands to `syncState`. */
export const view: StateProjection = orderSlot.projection((order) => ({
  count: order.items.length,
  total: order.total,
}));
