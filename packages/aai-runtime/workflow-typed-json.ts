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
 * Encode a value for the wire.
 *
 * @internal
 */
export function encodeTypedJson(value: unknown): string {
  return JSON.stringify(value, binaryReplacer);
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
