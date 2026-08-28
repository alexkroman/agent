// Copyright 2026 the AAI authors. MIT license.
/**
 * The DevKit's JSON-with-binary wire format, spelled once for both sides.
 *
 * ## Why it is needed at all
 *
 * At `specVersion >= 2` a run's `input` and `output`, a step's `input` and
 * `output`, and a hook's `metadata` are `Uint8Array` — the binary devalue format
 * (their own schema doc says so). `JSON.stringify` turns one of those into
 * `{"0":7,"1":0}`, an index map, and `JSON.parse` gives that object back. Nothing
 * errors: a run simply starts with garbage where its input should be, and the
 * failure surfaces inside devalue's deserializer several layers from the cause.
 *
 * So anything carrying Storage values over HTTP has to encode them, and BOTH
 * directions matter. The platform's route receives args (a `run_created` carries a
 * run's input) and returns entities (`runs.get` returns input and output), so a
 * codec on one side only corrupts the other.
 *
 * ## The format is THEIRS, not ours
 *
 * `{ __type: "Uint8Array", data: "<base64>" }` is what `@workflow/world-local`'s
 * `TypedJsonTransport` writes and reads, and what `@workflow/world-postgres`'s
 * queue transport reproduces. Matching it is deliberate rather than incidental:
 * their `createQueueHandler` — which the composition keeps — deserializes queue
 * bodies with that reviver, so a second format here would mean two encodings of
 * the same values in one process.
 *
 * It is reproduced rather than imported because `@workflow/world-local` is a
 * transitive dependency this package does not declare, and the shape is one
 * envelope.
 *
 * ## It is a REPLACER and a REVIVER, not a deep clone
 *
 * `JSON.stringify`'s replacer is called for every value, so nesting, arrays and
 * records all work without this module knowing anything about the DevKit's
 * entities — which is the point. A hand-written walk would need to know where the
 * binary fields are, and their schemas move.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/** What a `Uint8Array` becomes on the wire. */
type BinaryEnvelope = { __type: "Uint8Array"; data: string };

/** Is `value` one of those envelopes? */
function isBinaryEnvelope(value: unknown): value is BinaryEnvelope {
  return isRecord(value) && value.__type === "Uint8Array" && typeof value.data === "string";
}

/**
 * What the holder really had at `key`, BEFORE `toJSON` rewrote it.
 *
 * **An array holder is why this is not `isRecord(this) ? this[key] : value`.**
 * `isRecord` answers false for an array by design (`sdk/is-record.ts` excludes
 * them deliberately), so that spelling fell through to `value` for every array
 * ELEMENT — and `value` is exactly the already-mangled thing the replacer exists
 * to look past. Measured: `{b: buf}` encoded correctly while
 * `{chunks: [buf]}` came out as `{"type":"Buffer","data":[1,2,3]}`, i.e. the bug
 * this module's doc describes, reachable through
 * `streamer.writeToStreamMulti(name, runId, chunks)` and through any DevKit
 * method answering an array of `bytea` values. A plain `Uint8Array` in an array
 * survived, which is what kept it out of sight: only `Buffer` has the `toJSON`.
 *
 * The comment that spelling carried — "at the top level `JSON.stringify` passes
 * `{"": value}`, so the holder is always a record in practice" — was true of the
 * ROOT call and said nothing about the recursion, which is where arrays appear.
 *
 * `JSON.stringify` passes an array index as a STRING, so the `Number` is for the
 * type checker rather than for JavaScript — an array cannot be indexed by a
 * `string` in TypeScript, and converting is cheaper than a cast.
 */
function holderValue(holder: unknown, key: string, value: unknown): unknown {
  if (isRecord(holder)) return holder[key];
  if (Array.isArray(holder)) return holder[Number(key)];
  return value;
}

/**
 * `JSON.stringify` replacer: every `Uint8Array` becomes a tagged envelope.
 *
 * **It reads `this[key]`, not `value`, and that is not a style choice.**
 * `JSON.stringify` calls a value's own `toJSON()` BEFORE handing it to the
 * replacer — and `Buffer` has one, returning `{ type: "Buffer", data: [...] }`. So
 * a `Buffer` arrives here already converted and `value instanceof Uint8Array` is
 * FALSE for it. `this` is the holder object and `this[key]` is the original, which
 * is the only way to see what was really there.
 *
 * That matters because the Postgres world hands `Buffer`s back for every column it
 * reads as `bytea` — so testing `value` would carry a run's output across the wire
 * as `{type:"Buffer",data:[...]}` and hand the guest that object instead of bytes.
 * The DevKit's own transport tests `value`; it simply never carries a `Buffer`,
 * because a queue payload comes from devalue as a plain `Uint8Array`.
 *
 * **An ARRAY is a holder too**, which is the whole reason {@link holderValue}
 * exists rather than a bare `isRecord`. See its doc.
 *
 * @internal
 */
export function binaryReplacer(this: unknown, key: string, value: unknown): unknown {
  const raw = holderValue(this, key, value);
  // `Buffer.from(view)` COPIES rather than aliasing the underlying buffer, which
  // matters for a `Uint8Array` that is a view into a larger allocation: encoding
  // the whole allocation would be a data leak as well as wrong.
  return raw instanceof Uint8Array
    ? { __type: "Uint8Array", data: Buffer.from(raw).toString("base64") }
    : value;
}

/**
 * `JSON.parse` reviver: every tagged envelope becomes a `Uint8Array`.
 *
 * @internal
 */
export function binaryReviver(_key: string, value: unknown): unknown {
  return isBinaryEnvelope(value) ? new Uint8Array(Buffer.from(value.data, "base64")) : value;
}

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
function isPlainObject(value: unknown): value is Record<string, unknown> {
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
function withPlainViews(value: unknown, depth = 0): unknown {
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

/**
 * Encode a value for the wire.
 *
 * The pre-pass is {@link withPlainViews} — see its doc for what `Buffer`'s own
 * `toJSON` costs, and why the walk is cheaper than the thing it prevents.
 *
 * @internal
 */
export function encodeTypedJson(value: unknown): string {
  return JSON.stringify(withPlainViews(value), binaryReplacer);
}

/**
 * Decode a value off the wire.
 *
 * Throws on malformed JSON, which is correct for both callers: the guest fails the
 * step that was reading, and the platform answers 400. Neither should guess.
 *
 * @internal
 */
export function decodeTypedJson(text: string): unknown {
  return JSON.parse(text, binaryReviver);
}
