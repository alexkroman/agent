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
 * A `Date` is the SECOND type with that shape of failure, and it is the one that
 * stopped every durable run on the platform dead. Their schema declares
 * `timestamp('started_at')`, which drizzle reads in `mode: 'date'`, so
 * `runs.get` answers real `Date`s — `createdAt`, `startedAt`, `completedAt`,
 * `expiresAt`, and the same fields on a step, a hook and a wait. `JSON.stringify`
 * hands back an ISO STRING and, with no reviver for it, the guest's runtime then
 * computes `workflowStartedAt = +workflowRun.startedAt` — `NaN`, which
 * `JSON.stringify` writes into the enqueued step payload as `null`. The guest's
 * own step handler rejects it:
 *
 *     guest answered HTTP 500: [{ "expected": "number", "code": "invalid_type",
 *       "path": ["workflowStartedAt"], "message": "expected number, received null" }]
 *
 * The platform's sweep then burns its five attempts and abandons the message, so
 * a run reaches `step_created` and stops there FOREVER, with the run row still
 * `running` and nothing in the journal naming a date. Reproduced end to end
 * against a local stack with the `link-digest` template.
 *
 * So anything carrying Storage values over HTTP has to encode them, and BOTH
 * directions matter. The platform's route receives args (a `run_created` carries a
 * run's input) and returns entities (`runs.get` returns input and output), so a
 * codec on one side only corrupts the other.
 *
 * ## The binary format is THEIRS, and the Date envelope is OURS
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
 * `{ __type: "Date", iso }` has no such counterpart — they have no date envelope
 * at all — so this one is invented, and **that is why there are TWO pairs here
 * rather than one.** A codec is safe to extend only where BOTH ends are ours:
 *
 * - **The storage RPC** ({@link encodeStorageJson} / {@link decodeStorageJson})
 *   is ours on both sides — `workflow-platform-storage.ts` and
 *   `aai-server/workflow-storage-handler.ts` — so it carries the Date envelope.
 * - **The queue payload** ({@link encodeTypedJson}) is ours on the way OUT and
 *   THEIRS on the way in: `workflow-platform-queue.ts` encodes the message and
 *   the DevKit's own `createQueueHandler` reads it back. So it stays strictly
 *   their format, and a `Date` on it goes as the ISO string `toJSON` produces —
 *   which their schemas coerce, and which is the only thing they can read.
 *
 * Collapsing the two costs a second stalled run, one layer past the first: with
 * the Date envelope on the queue path their parse answers
 * `requestedAt: expected date, received Invalid Date` — `new Date(anObject)` —
 * and the sweep abandons the message exactly as before. Measured, in the course
 * of fixing the `workflowStartedAt` half.
 *
 * ## An envelope is only the codec's if the codec WROTE it
 *
 * Both revivers recognise an envelope STRUCTURALLY, so for a long time an
 * author's own `{ __type: "Uint8Array", data }` decoded as bytes — type confusion
 * across a trust boundary, a run's input arriving at `POST /workflows/runs`.
 * `workflow-typed-json-escape.ts` closes it by renaming an author's reserved keys
 * on the way out and back on the way in; its doc carries the scheme and the
 * argument that the rename is total. A bare `__type` still decodes as an
 * envelope, so their transport's output and every row already on the wire are
 * unaffected — which is why the deployment order is decoder-first.
 *
 * ## The two codecs agree on a date SHAPE, and differ only on what they EMIT
 *
 * `{ __type: "Date", iso }` used to survive `decodeTypedJson` as a plain object
 * and be revived by `decodeStorageJson`, so one author value meant two different
 * things depending on which wire it took. With escaping, neither revives an
 * author's date-shaped object: both hand back the record that went in, which is
 * the round trip. The asymmetry that REMAINS is the split above and is
 * deliberate — the storage RPC emits the date envelope because both ends are
 * ours, the queue path never emits one because the DevKit's reviver is the far
 * end and has no date envelope to read. Shapes agree; emission differs.
 *
 * ## It is a REPLACER and a REVIVER, not a deep clone
 *
 * `JSON.stringify`'s replacer is called for every value, so nesting, arrays and
 * records all work without this module knowing anything about the DevKit's
 * entities — which is the point. A hand-written walk would need to know where the
 * binary fields are, and their schemas move.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { escapeReservedKeys, unescapeIfRecord } from "./workflow-typed-json-escape.ts";

/** What a `Uint8Array` becomes on the wire. */
type BinaryEnvelope = { __type: "Uint8Array"; data: string };

/** Is `value` one of those envelopes? */
function isBinaryEnvelope(value: unknown): value is BinaryEnvelope {
  return isRecord(value) && value.__type === "Uint8Array" && typeof value.data === "string";
}

/**
 * What a `Date` becomes on the wire.
 *
 * `iso` is nullable so an INVALID date round-trips as itself. `toISOString()`
 * throws on one, and a codec that throws while encoding a reply turns a bad
 * timestamp in one row into a 500 for the whole call — where the DevKit's own
 * behaviour for a date it cannot read is to carry the `NaN` onward.
 */
type DateEnvelope = { __type: "Date"; iso: string | null };

/** Is `value` one of those envelopes? */
function isDateEnvelope(value: unknown): value is DateEnvelope {
  return (
    isRecord(value) &&
    value.__type === "Date" &&
    (typeof value.iso === "string" || value.iso === null)
  );
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
 * This is the DevKit-COMPATIBLE half — the one whose output their own reviver
 * reads — so it encodes nothing they do not encode. {@link storageReplacer} is
 * the one that also carries dates. See the module doc for which path is which.
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
  if (raw instanceof Uint8Array) {
    return { __type: "Uint8Array", data: Buffer.from(raw).toString("base64") };
  }
  return escapeIfPlain(value);
}

/**
 * An author's own object with its reserved keys renamed, or `value` untouched.
 *
 * **It reads `value`, not `raw`, and that is the opposite of the two checks above
 * it — deliberately.** `raw` exists to see past `Buffer`'s and `Date`'s own
 * `toJSON`, which are the two this codec must look THROUGH. An object carrying a
 * `toJSON` an AUTHOR wrote is the other case: JSON's own semantics say its result
 * is what gets serialized, so its result is what has to be escaped. Escaping
 * `raw` there would silently undo the author's `toJSON`, and escaping neither
 * would let its result smuggle a `__type` through.
 *
 * A class instance is left alone by {@link isPlainObject} for the reason
 * {@link withPlainViews} gives: rebuilding one structurally destroys it.
 */
function escapeIfPlain(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return escapeReservedKeys(value) ?? value;
}

/**
 * `JSON.parse` reviver: every tagged binary envelope becomes a `Uint8Array`.
 *
 * @internal
 */
export function binaryReviver(_key: string, value: unknown): unknown {
  if (isBinaryEnvelope(value)) return bytesFromBase64(value.data);
  return unescapeIfRecord(value);
}

/**
 * A tagged envelope's payload as bytes, or a throw.
 *
 * **`Buffer.from(s, "base64")` cannot be used here: it is LENIENT.** It drops any
 * character outside the alphabet and returns whatever the survivors decode to, so
 * `"not base64 at all!!"` came back as ten arbitrary bytes with nothing raised —
 * a corrupt payload reaching a step as plausible-looking binary, which is the
 * same silent-garbage failure this whole module exists to prevent, one layer in.
 *
 * `Uint8Array.fromBase64` throws instead, and `lastChunkHandling: "strict"` is
 * what makes it reject the two shapes the lenient decoder invents a value for:
 * an unpadded final chunk (`"aGVsbG8"`), and a final chunk whose unused trailing
 * bits are non-zero (`"AAB="`, which decodes to the same bytes as `"AAA="` and so
 * has two spellings). Every string this codec EMITS is canonical padded base64,
 * so nothing it wrote can fail this.
 *
 * ASCII whitespace is still accepted — the spec allows it at any position, and
 * unlike the cases above it decodes to one unambiguous answer rather than to a
 * guess.
 */
function bytesFromBase64(data: string): Uint8Array {
  try {
    return Uint8Array.fromBase64(data, { alphabet: "base64", lastChunkHandling: "strict" });
  } catch (cause) {
    // Named, because the raw message ("Found a character that cannot be part of a
    // valid base64 string") says nothing about which wire or which field.
    throw new Error("typed-json: Uint8Array envelope carries malformed base64", { cause });
  }
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
 * `JSON.stringify` replacer for the STORAGE RPC: binary, plus dates.
 *
 * A `Date` reaches a replacer already rewritten, exactly as a `Buffer` does and
 * for the same `toJSON` reason — which is why this reads `raw` and why a check
 * on `value` could not be written at all: by then it is an ISO string,
 * indistinguishable from a tenant's own.
 *
 * @internal
 */
export function storageReplacer(this: unknown, key: string, value: unknown): unknown {
  const raw = holderValue(this, key, value);
  if (raw instanceof Date) {
    const time = raw.getTime();
    return { __type: "Date", iso: Number.isNaN(time) ? null : raw.toISOString() };
  }
  return binaryReplacer.call(this, key, value);
}

/**
 * `JSON.parse` reviver for the STORAGE RPC: binary, plus dates.
 *
 * @internal
 */
export function storageReviver(key: string, value: unknown): unknown {
  return isDateEnvelope(value) ? dateFromEnvelope(value.iso) : binaryReviver(key, value);
}

/**
 * A date envelope's payload as a `Date`, or a throw.
 *
 * `null` is the encoder's own spelling of an INVALID date (see
 * {@link DateEnvelope}), so it revives as one — that is a round trip, not
 * corruption.
 *
 * A non-null string that will not parse is the other thing entirely: nothing this
 * codec emits can produce one, because `toISOString()` either throws or returns a
 * string `Date` re-reads. So it is a corrupt or forged wire, and reviving it
 * would hand the guest an `Invalid Date` whose `+date` is `NaN` — the exact value
 * that stalled every durable run on the platform and the reason this module
 * exists. Failing the decode names the problem where it happened instead.
 */
function dateFromEnvelope(iso: string | null): Date {
  if (iso === null) return new Date(Number.NaN);
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    throw new Error(`typed-json: Date envelope carries an unparsable iso: ${JSON.stringify(iso)}`);
  }
  return when;
}

/**
 * Encode a value for the QUEUE, in the DevKit's own format.
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
 * Encode a value for the storage RPC.
 *
 * @internal
 */
export function encodeStorageJson(value: unknown): string {
  // The same {@link withPlainViews} pre-pass, and this is the wire it was measured
  // on: the Postgres world hands back a `Buffer` for every `bytea` column, so a
  // storage reply is where the `toJSON` cost lands.
  return JSON.stringify(withPlainViews(value), storageReplacer);
}

/**
 * Decode a value off the storage RPC.
 *
 * Throws on malformed JSON, for the reason {@link decodeTypedJson} gives.
 *
 * @internal
 */
export function decodeStorageJson(text: string): unknown {
  return JSON.parse(text, storageReviver);
}

/**
 * Decode a value off the wire, in the DevKit's own format.
 *
 * Throws on malformed JSON, which is correct for both callers: the guest fails the
 * step that was reading, and the platform answers 400. Neither should guess.
 *
 * @internal
 */
export function decodeTypedJson(text: string): unknown {
  return JSON.parse(text, binaryReviver);
}
