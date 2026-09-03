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
 * - **The storage codec** ({@link encodeStorageJson} / {@link decodeStorageJson})
 *   is ours on both sides — it is what every journal backend crosses on
 *   (`workflow-journal-platform.ts`, `workflow-journal-postgres.ts`, and
 *   `aai-server/platform-workflow-journal.ts` at the far end) — so it carries
 *   the Date envelope.
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
 * ## `Map` and `Set` are ours too, and they ride the STORAGE codec only
 *
 * A step's output is an AUTHOR's value, and `JSON.stringify(new Map(…))` is
 * `{}` — no error, no key, nothing in the journal naming a collection. So a
 * `ctx.step` answering a `Map` resumed with an EMPTY OBJECT: the same class of
 * silent failure as the `Uint8Array` index map and the `NaN` date above, and
 * one that hides better than either, since an index map at least still carries
 * the bytes.
 *
 * `{ __type: "Map", entries: [[k, v], …] }` and `{ __type: "Set", values: […] }`
 * are the envelopes. Three things about them are decisions rather than details:
 *
 * - **The entries are PAIRS, and both halves recurse.** A `Map`'s keys are
 *   arbitrary values rather than strings, so the tempting
 *   `Object.fromEntries(map)` would stringify every one of them and lose a
 *   `Date` or a `Uint8Array` key outright. Encoding pairs instead costs nothing
 *   and buys the rest for free: `JSON.stringify` calls the replacer for every
 *   element of the array this hands back, so a nested `Map`, a `Map` inside a
 *   `Set`, and bytes or a date in EITHER half all work with no further code.
 *   {@link binaryReplacer}'s holder read is what makes a `Buffer` in one
 *   survive — the pair array is a holder like any other.
 * - **They join the storage codec and NOT the queue one**, exactly as the date
 *   envelope does and for the same reason: the queue's far end is not ours. It
 *   costs nothing here because a queue payload is engine-internal — a run id
 *   and a step key — so no author value reaches it. A `Map` on that path would
 *   still encode as `{}`, which is this codec's general unsupported-type hole
 *   and is deliberately still open: closing it wants a structural check at the
 *   step boundary, not a fourth envelope on a wire nobody sends one over.
 * - **Adding a kind cannot weaken the escape, and that is the property to
 *   preserve.** `workflow-typed-json-escape.ts` renames the reserved KEY family
 *   `/^__+type$/` and never reads the tag's VALUE, so an author's own
 *   `{ __type: "Map", entries: [] }` leaves as `{ ___type: "Map", entries: [] }`
 *   and comes back as itself at any depth — and would do so for a tag spelling
 *   this codec has never heard of. Totality is a property of the escape rather
 *   than of the envelope set, which is what makes the set extensible at all.
 *
 * ## It is a REPLACER and a REVIVER, not a deep clone
 *
 * `JSON.stringify`'s replacer is called for every value, so nesting, arrays and
 * records all work without this module knowing anything about the DevKit's
 * entities — which is the point. A hand-written walk would need to know where the
 * binary fields are, and their schemas move.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import {
  escapeReservedKeys,
  escapeUnstorableCharacters,
  escapeUnstorableKeys,
  unescapeIfRecord,
  unescapeUnstorableCharacters,
} from "./workflow-typed-json-escape.ts";
import { isPlainObject, withPlainViews } from "./workflow-typed-json-views.ts";

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
 * What a `Map` becomes on the wire: its entries, as `[key, value]` pairs.
 *
 * `readonly unknown[]` rather than a pair tuple because the DECODE side reads
 * this off untrusted JSON, where an element is whatever a peer sent — the pair
 * shape is checked by {@link mapFromEntries} and cannot be assumed by a type.
 */
type MapEnvelope = { __type: "Map"; entries: readonly unknown[] };

/** Is `value` one of those envelopes? */
function isMapEnvelope(value: unknown): value is MapEnvelope {
  return isRecord(value) && value.__type === "Map" && Array.isArray(value.entries);
}

/** What a `Set` becomes on the wire. */
type SetEnvelope = { __type: "Set"; values: readonly unknown[] };

/** Is `value` one of those envelopes? */
function isSetEnvelope(value: unknown): value is SetEnvelope {
  return isRecord(value) && value.__type === "Set" && Array.isArray(value.values);
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
  // Every STRING the codec emits, including the ones inside the envelopes it
  // builds — a `jsonb` column cannot hold a NUL or a lone surrogate, and the
  // driver's refusal is a retryable 503 for a value that can never be accepted.
  // A no-op for anything holding neither, which is every real string; see
  // `escapeUnstorableCharacters`.
  if (typeof value === "string") return escapeUnstorableCharacters(value);
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
  // Two escapes, and a KEY needs the second for the same reason a value does: it
  // is a string, and it cannot be enveloped out of the problem. They compose in
  // either order (the escape module's doc proves it); this order is the one
  // `unescapeIfRecord` inverts.
  const renamed = escapeReservedKeys(value) ?? value;
  return escapeUnstorableKeys(renamed) ?? renamed;
}

/**
 * `JSON.parse` reviver: every tagged binary envelope becomes a `Uint8Array`.
 *
 * @internal
 */
export function binaryReviver(_key: string, value: unknown): unknown {
  // Strings first, and the ordering is free rather than delicate: a string is
  // never an envelope, and a reviver runs bottom-up — so an envelope's own
  // `data` has already been through here (a no-op, base64 holding none of the
  // escapable units) by the time the envelope itself is seen.
  if (typeof value === "string") return unescapeUnstorableCharacters(value);
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
  const collection = collectionEnvelope(value);
  if (collection !== undefined) return collection;
  return binaryReplacer.call(this, key, value);
}

/**
 * A `Map` or `Set` as its envelope, or `undefined` when `value` is neither.
 *
 * **It reads `value`, not `raw`, and unlike the two checks above it that is the
 * SAFE direction rather than a compromise.** `raw` exists to see past a
 * `toJSON` the codec must look THROUGH — `Buffer`'s and `Date`'s. Neither
 * `Map` nor `Set` has one, so `holder[key]` being a collection implies `value`
 * is that same collection and the two checks agree; where they differ is an
 * author's own `toJSON` RETURNING one, and there JSON's own semantics say its
 * result is what gets serialized. So `value` is a strict superset, for the same
 * reason {@link escapeIfPlain} reads it.
 *
 * Neither branch may fall through to {@link binaryReplacer}: a collection is
 * not a plain object, so `escapeIfPlain` hands it back untouched and
 * `JSON.stringify` writes `{}` — the silent loss this exists to prevent.
 */
function collectionEnvelope(value: unknown): MapEnvelope | SetEnvelope | undefined {
  if (value instanceof Map) return { __type: "Map", entries: [...value] };
  if (value instanceof Set) return { __type: "Set", values: [...value] };
  return undefined;
}

/**
 * `JSON.parse` reviver for the STORAGE RPC: binary, plus dates, plus
 * collections.
 *
 * **A bottom-up reviver is what makes the collection cases free.** `JSON.parse`
 * revives a value's children before the value, so by the time a `Map` envelope
 * is seen its `entries` array holds pairs whose halves have already become
 * whatever they were — bytes, a date, an inner `Map` — and there is nothing
 * left to walk. It is also why the escape scheme renames a KEY rather than
 * wrapping a value; `workflow-typed-json-escape.ts`'s doc carries that.
 *
 * @internal
 */
export function storageReviver(key: string, value: unknown): unknown {
  if (isDateEnvelope(value)) return dateFromEnvelope(value.iso);
  if (isMapEnvelope(value)) return mapFromEntries(value.entries);
  if (isSetEnvelope(value)) return new Set(value.values);
  return binaryReviver(key, value);
}

/**
 * A map envelope's entries as a `Map`, or a throw.
 *
 * `new Map(entries)` on its own is not an option: a forged `entries` of
 * `[1, 2]` makes it raise `TypeError: Iterator value 1 is not an entry object`
 * out of the middle of a `JSON.parse`, naming neither the wire nor the field —
 * and one of `[["k"]]` does not raise at all, mapping `"k"` to `undefined`,
 * which is an INVENTED value of exactly the kind {@link bytesFromBase64} and
 * {@link dateFromEnvelope} exist to refuse. So the pair shape is checked and
 * the failure is named where it happened.
 *
 * A duplicate key is NOT an error: `new Map` keeps the last, which is a `Map`'s
 * own semantics rather than a guess, and nothing this codec emits can produce
 * one — a real `Map`'s keys are distinct by construction.
 */
function mapFromEntries(entries: readonly unknown[]): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(
        `typed-json: Map envelope carries an entry that is not a [key, value] pair: ${JSON.stringify(entry)}`,
      );
    }
    out.set(entry[0], entry[1]);
  }
  return out;
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
