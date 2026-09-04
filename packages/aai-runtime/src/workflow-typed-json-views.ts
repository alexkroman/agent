// Copyright 2026 the AAI authors. MIT license.
/**
 * The `Buffer`-to-view pre-pass `workflow-typed-json.ts` runs before every encode.
 *
 * It is here rather than in the codec for one reason: it is a PERFORMANCE
 * concern, not a correctness one. The codec is correct without it — see
 * {@link withPlainViews}'s last paragraph, whose whole claim is that the worst
 * case of this file is the behaviour of not having it — and keeping the two apart
 * means a reader auditing what crosses the wire never has to hold the
 * optimization in their head.
 *
 * {@link isPlainObject} rides along because both halves need it: this file to
 * decide what is safe to rebuild, and the codec to decide whose keys are safe to
 * escape. It answers the same question for both — "is this a `{}` or a class
 * instance" — and rebuilding a class instance structurally destroys it either way.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * How deep {@link withPlainViews} walks before giving up.
 *
 * A pre-pass over a CYCLIC value would recurse forever where `JSON.stringify`
 * throws "Converting circular structure to JSON". Past the cap the value is handed
 * back untouched, so that error is still the one a caller sees — the pre-pass is an
 * optimization and must never be the thing that fails. The DevKit's entities nest a
 * handful of levels; this is far beyond them.
 */
const VIEW_WALK_MAX_DEPTH = 32;

/**
 * A `{}`-shaped object, as opposed to a class instance.
 *
 * The prototype test is what makes {@link withPlainViews} safe to let past: a class
 * instance must NOT be rebuilt key-by-key, because `isRecord(new Date())` is true
 * and `Object.keys` of a `Date` is empty — a structural copy would erase it.
 *
 * `isRecord` and not the two comparisons inline: its array exclusion is wanted here
 * (the caller has already dispatched an array to {@link viewsInArray} before asking)
 * and `guard-invariants` rule 17 is right that the open-coded spelling narrows to
 * `object`, on which the property reads below would each need a cast.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The same value with every `Buffer` swapped for a plain `Uint8Array` view.
 *
 * ## What it buys
 *
 * `JSON.stringify` calls `toJSON` BEFORE the replacer, and `Buffer.prototype.toJSON`
 * builds `{type:"Buffer",data:[…]}` — an N-element ARRAY OF NUMBERS, one per byte —
 * which {@link binaryReplacer} then throws away, having read the original off the
 * holder. The bytes were still materialized. Both sides of the guest↔platform
 * storage wire pay it, per call, and the Postgres world hands back a `Buffer` for
 * every `bytea` column: a run's input and output, a step's, hook metadata, every
 * stream chunk. Measured through `encodeTypedJson` on Node 26 (the version this
 * package requires), best of five:
 *
 * | payload | without | with |
 * | --- | --- | --- |
 * | `events.create`, 64 KiB x1000 | 273 ms | 98 ms |
 * | `steps.get`, two 1 MiB fields x50 | 740 ms | 223 ms |
 * | `runs.list`, 100 entities w/ 4 KiB each x100 | 363 ms | 199 ms |
 * | 500 plain entities, NO binary x200 | 74 ms | 110 ms |
 *
 * The last row is the cost, stated rather than hidden: a payload with no binary in
 * it pays for the traversal that discovers so — 0.18 ms per encode of a 500-entity
 * page, against 0.18 ms saved per `events.create`, which is the call every
 * step-to-step hop makes and the far commoner one. Every binary-carrying path is
 * 1.8-3.3x faster.
 *
 * The swap is ZERO-COPY: `new Uint8Array(b.buffer, b.byteOffset, b.byteLength)` is a
 * window onto the same memory, and a plain `Uint8Array` has no `toJSON`, so
 * `stringify` hands the replacer the array itself and nothing is built to discard.
 * The `byteOffset`/`byteLength` pair is not decoration — Node's pooled buffers are
 * windows into a shared 8 KiB `ArrayBuffer`, so a view built without them would
 * carry whatever else is in the pool.
 * `Buffer.from(raw)` in the replacer still copies exactly that window, which is what
 * keeps the data-leak argument in its doc true — Node's pooled buffers share one
 * large `ArrayBuffer`, so the window is the whole point.
 *
 * ## Why the walk is cheap, and why it is opportunistic
 *
 * It never descends INTO a view — bytes cannot contain a `Buffer` — so it is
 * O(structure), not O(bytes); that is the same trap `workflow-storage-egress.ts`
 * documents, where `isRecord` answering true for a `Buffer` made a walk visit one
 * byte at a time.
 *
 * **It allocates NOTHING until it finds something to change**, which is what makes
 * it safe to run on every encode. A first draft mapped every node and compared
 * afterwards, and that is a copy of the whole structure whether or not any binary is
 * in it: measured, a 500-entity binary-free page went from 53 ms to 127 ms across
 * 200 encodes — a 2.4x REGRESSION on the commonest reply on this wire, paid to
 * speed up a case it did not contain. Now the copy is made lazily, on the first
 * child that differs, by shallow-spreading the node the walk is already holding; a
 * payload with no binary in it returns the identical object and the walk is a
 * traversal.
 *
 * And it only rebuilds plain objects and arrays. A class instance passes through
 * untouched, because copying one structurally would DESTROY it — `isRecord(new
 * Date())` is true, and `Object.entries` of a `Date` is empty. So a `Buffer` reached
 * only through a class instance is missed, its `toJSON` fires, and
 * {@link binaryReplacer} handles it exactly as it did before. The worst case of this
 * function is the behaviour without it.
 */
export function withPlainViews(value: unknown, depth = 0): unknown {
  if (depth > VIEW_WALK_MAX_DEPTH) return value;
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // Any other view (a plain `Uint8Array`, a `DataView`) is already toJSON-free, and
  // walking into one is the per-byte mistake named above.
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return viewsInArray(value as unknown[], depth);
  return isPlainObject(value) ? viewsInRecord(value, depth) : value;
}

/**
 * {@link withPlainViews} over an array's elements.
 *
 * `out` stays `undefined` until an element differs, and only then is the array
 * copied — see {@link withPlainViews}'s doc for what the eager version cost.
 */
function viewsInArray(items: unknown[], depth: number): unknown {
  let out: unknown[] | undefined;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const next = withPlainViews(item, depth + 1);
    if (out === undefined) {
      if (next === item) continue;
      out = [...items];
    }
    out[i] = next;
  }
  return out ?? items;
}

/**
 * {@link withPlainViews} over a plain object's own properties.
 *
 * `Object.keys` rather than `Object.entries` (which allocates a two-element array
 * per property, most of the regression that doc records) and rather than `for…in`
 * (which reaches the prototype chain, so biome's `useGuardForIn` rightly wants a
 * `hasOwn` call per property). The lazy `{ ...value }` on the first changed child is
 * one allocation and keeps key order; later keys are copied as they were and
 * overwritten if they change.
 */
function viewsInRecord(value: Record<string, unknown>, depth: number): unknown {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const child = value[key];
    const next = withPlainViews(child, depth + 1);
    if (out === undefined) {
      if (next === child) continue;
      out = { ...value };
    }
    out[key] = next;
  }
  return out ?? value;
}
