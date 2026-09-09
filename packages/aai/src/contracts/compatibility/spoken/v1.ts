// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:spoken` epoch 1.
 *
 * Epoch 2 added the optional `code` and `match` scorers to `ResolveOneOptions`.
 * An epoch-1 author passed `describe`, `label` and a hand-written `score`, and
 * that is what this file pins: the additions are optional, and `score` is still
 * the seam for a domain scorer no built-in can serve.
 *
 * `entertainment-picks-agent` is the shipped instance of that last clause — its
 * listener says "books" where the field says "book", which `match` has no
 * stemming for — so a later epoch removing `score` breaks a real template, not
 * just this example.
 */

import { resolveOne } from "@alexkroman1/aai";

type Order = { id: string; item: string };

const orders: Order[] = [
  { id: "W1001", item: "blue shirt" },
  { id: "W1002", item: "red hat" },
];

export const picked = resolveOne(orders, "the red one", {
  describe: (order) => order.item,
  label: "order",
  score: (order, spoken) => (spoken.includes(order.item) ? 1 : 0),
});
