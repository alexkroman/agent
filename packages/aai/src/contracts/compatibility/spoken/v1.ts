// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:spoken` epoch 1.
 *
 * Epoch 2 added the optional `code` and `match` scorers to `ResolveOneOptions`.
 * An epoch-1 author passed `describe`, `label` and a hand-written `score`, and
 * that is what this pins: the additions are optional, and `score` is still the
 * seam for a domain scorer no built-in can serve —
 * `entertainment-picks-agent` is the shipped instance, its listener saying
 * "books" where the field says "book".
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 10 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import type { MintCodeOptions, ResolveOneOptions } from "../../../index.ts";
import {
  mintCode,
  resolveOne,
  spokenAlphanumeric,
  spokenDate,
  spokenDigits,
  spokenMoney,
  spokenOrdinal,
  spokenTime,
} from "../../../index.ts";

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

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  mintCodeOptions: MintCodeOptions;
  resolveOneOptions: ResolveOneOptions<{ id: string }>;
};

export const epoch1Values = [
  mintCode,
  spokenAlphanumeric,
  spokenDate,
  spokenDigits,
  spokenMoney,
  spokenOrdinal,
  spokenTime,
] as const;
