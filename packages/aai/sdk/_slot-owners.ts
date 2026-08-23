// Copyright 2026 the AAI authors. MIT license.
/**
 * One key, one slot — the ownership check behind {@link sessionSlot}.
 *
 * Its own module because `session-slot.ts` is at the 500-line cap and this is
 * the seam that comes out cleanly: nothing here knows what a slot DOES, only
 * which slot reached a key first in a given session and whether the next one
 * agrees about the shape stored there.
 *
 * @module _slot-owners
 */

import { isRecord } from "./is-record.ts";
import type { SlotStore } from "./session-state.ts";

/**
 * Which slot owns each key, per session store, and what shape it stores.
 *
 * `SessionSlot.key`'s doc has always said "Two slots must not share one", and
 * nothing checked it: two modules declaring `sessionSlot("cart", …)` over
 * DIFFERENT shapes read and wrote each other's value, so a slot typed
 * `{ items: Item[] }` was handed `{ n: 1 }` and the type system said nothing —
 * the one failure a typed seam exists to prevent, reintroduced by a name
 * collision.
 *
 * **Per STORE, not global, and that is what makes the check safe to make at
 * all.** A store is one session, so the question it asks is "did two slots that
 * disagree touch this key in the same session", which is the bug. A
 * module-level registry of declared keys would instead ask "was this key ever
 * declared twice in this process", which is not: this repo alone declares
 * `sessionSlot("cart", …)` 35 times across templates, specs and doc examples,
 * several of them in one test file, and every one is correct. It is also why a
 * hot reload cannot trip this — `aai dev` rebuilds the agent into a fresh
 * bundle carrying its own copy of this module, so the reloaded slot meets an
 * empty map.
 *
 * **And it compares SHAPES, not identities**, because two declarations of the
 * same thing are legitimate and one of them is in this SDK: `dialog()` builds a
 * slot per key, and a dialog written as a spec and the same dialog written as a
 * machine are interchangeable by design — they occupy one key, store one
 * snapshot shape, and a session persisted by either is readable by the other.
 * What is never legitimate is two slots that disagree about what the key holds.
 *
 * Keyed weakly so a finished session's entry goes with it.
 */
const keyOwners = new WeakMap<SlotStore, Map<string, KeyOwner>>();

/** The slot behind a key in one store, and how to describe what it stores. */
export type KeyOwner = { owner: object; shape: () => string | undefined };

/**
 * The top-level shape of a stored value, as a string two slots can be compared
 * by — or `undefined` when it cannot be determined, which is read as "no proof
 * of a conflict" rather than as a conflict.
 *
 * Top-level keys only: this is a collision detector, not a schema. Two slots
 * that agree on every key they store and disagree deeper are not the failure
 * this exists to catch (that one has a compiler behind it — both declarations
 * type their own value).
 */
export function shapeOf(create: () => unknown): string | undefined {
  let value: unknown;
  try {
    value = create();
  } catch {
    // A factory that throws has a bigger problem, and it will surface on the
    // first real access with its own error. Refusing to guess here keeps this
    // check from turning that into a message about key collisions.
    return undefined;
  }
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return `{${Object.keys(value).sort().join(",")}}`;
  return value === null ? "null" : typeof value;
}

/**
 * Record that `owner` is the slot behind `key` in this store, or throw naming
 * the collision.
 */
export function claimKey(store: SlotStore, key: string, claim: KeyOwner): void {
  let owners = keyOwners.get(store);
  if (owners === undefined) {
    owners = new Map();
    keyOwners.set(store, owners);
  }
  const existing = owners.get(key);
  if (existing === undefined) {
    owners.set(key, claim);
    return;
  }
  if (existing.owner === claim.owner) return;
  const held = existing.shape();
  const wanted = claim.shape();
  if (held === undefined || wanted === undefined || held === wanted) return;
  throw new Error(
    `Two slots share the key "${key}" in one session and disagree about what it holds: one stores ${held}, the other ${wanted}. Each is reading and writing the other's value while its types say otherwise — a key IS a slot's identity, so give one of the two \`sessionSlot("${key}", …)\` declarations a name of its own.`,
  );
}
