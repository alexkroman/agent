// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime half of `SessionSlotOptions.caps` — a growth bound the SLOT
 * enforces on the top-level arrays of its value, on every store.
 *
 * Ten templates paired a `MAX_*` constant with a wrapper whose whole body was
 * `pushCapped(state.log, line, MAX)`, and a wrapper caps only the paths that
 * call it: `executive-assistant` capped `log` and `exchange` that way while
 * `reflections`, `sent` and `triageExamples` were pushed to directly, and all
 * three rode every `syncState` frame. A cap declared on the slot holds for the
 * stored value whatever path wrote it, which is the same argument `after`
 * makes for a derived field — the rule lives with the slot rather than being
 * re-listed at every call site, where one eventually forgets it.
 *
 * **Top-level arrays only.** A nested list (`incident.timeline`, one per
 * incident) has no single key to declare, so it stays on `pushCapped`; the two
 * are the same bound at two depths, and `pushCapped` stays public for the
 * nested one.
 *
 * Split out of `sdk/session-slot.ts` for the 500-line cap that file sits
 * against. Nothing outside this package imports it; `session-slot.ts` is the
 * only caller.
 *
 * @module _session-slot-caps
 */

import { isRecord } from "./is-record.ts";
import type { SlotCaps } from "./session-slot-types.ts";

/** One declared cap, validated: the key and the most entries it keeps. */
type Cap = readonly [key: string, max: number];

/**
 * Compile a slot's `caps` into the function its writers run before a store.
 *
 * Validated ONCE, at declaration: a cap that is not a non-negative integer is
 * refused the moment the slot is declared, naming the slot and the key, rather
 * than being met as a `splice(0, NaN)` that silently keeps everything.
 * Zero is legal and keeps nothing, matching `pushCapped`.
 *
 * The returned function TRIMS IN PLACE — the value it is handed is always the
 * slot's own (a fresh default, a private draft, or `set`'s copy), never the
 * caller's — dropping the OLDEST entries so the tail a reader wants
 * (`log.at(-1)`, the newest finding) is the part that survives. It returns the
 * same value so a call site can wrap an expression.
 *
 * @param slotKey - The slot's key, for the refusal message.
 * @param caps - What the author declared, or nothing.
 */
export function compileSlotCaps<T>(
  slotKey: string,
  caps: SlotCaps<T> | undefined,
): (value: T) => T {
  const compiled: Cap[] = [];
  for (const [key, max] of Object.entries(caps ?? {})) {
    // An absent value is "no cap" — the type admits `undefined` under
    // `exactOptionalPropertyTypes` only by omission, but a spread of a
    // conditional config can still produce one.
    if (max === undefined) continue;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 0) {
      throw new Error(
        `sessionSlot("${slotKey}"): caps.${key} must be a non-negative integer — got ${String(max)}.`,
      );
    }
    compiled.push([key, max]);
  }
  if (compiled.length === 0) return (value) => value;
  return (value) => {
    if (!isRecord(value)) return value;
    for (const [key, max] of compiled) {
      const list = value[key];
      if (Array.isArray(list) && list.length > max) list.splice(0, list.length - max);
    }
    return value;
  };
}
