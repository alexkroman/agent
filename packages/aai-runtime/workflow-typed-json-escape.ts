// Copyright 2026 the AAI authors. MIT license.
/**
 * What keeps an AUTHOR's object from impersonating a tagged envelope.
 *
 * ## The hole this closes
 *
 * `workflow-typed-json.ts` tags a `Uint8Array` as
 * `{ __type: "Uint8Array", data: "<base64>" }` and a `Date` as
 * `{ __type: "Date", iso }`, and both revivers recognise one STRUCTURALLY —
 * there is nothing in the shape that says who wrote it. So an author's plain
 * object of that shape went in one end and a `Uint8Array` came out the other,
 * at any nesting depth, with nothing raised:
 *
 *     decodeTypedJson(encodeTypedJson({ __type: "Uint8Array", data: "aGVsbG8=" }))
 *     // -> Uint8Array(5) [104, 101, 108, 108, 111]
 *
 * A run's `input` reaches this codec from `POST /workflows/runs`, which is public
 * HTTP, so that is type confusion across a trust boundary: a step that declared
 * `z.object({ __type: z.string() })` receives bytes instead, and a step reading
 * `input.data` as a string receives one that has silently become binary.
 *
 * ## The scheme: rename the tag key, never wrap the value
 *
 * On encode, a plain object carrying a RESERVED key gets that key renamed by one
 * underscore — `__type` to `___type`, `___type` to `____type`. On decode the
 * rename is undone. The envelopes the codec itself emits are built fresh and
 * never pass through here, so their `__type` survives and stays the only
 * unambiguous one.
 *
 * **Renaming the key rather than wrapping the object is what makes this
 * terminate.** The obvious alternative — emit `{ __type: "escape", value: v }` —
 * does not: `v` still carries `__type`, so it needs escaping too, and the reviver
 * runs bottom-up and would revive the inner envelope before the wrapper could
 * stop it. A key rename has no inner value to re-enter.
 *
 * ## Why it is TOTAL, which is the property that matters
 *
 * The rename is `n` underscores to `n + 1` for every key matching `_{2,}type`,
 * and the identity everywhere else. That map is INJECTIVE (distinct keys stay
 * distinct) and nothing maps onto `__type`, so decode can invert it exactly. Two
 * escapable keys in one object cannot collide either: `{ __type, ___type }`
 * becomes `{ ___type, ____type }`, which is why the copy is built fresh from the
 * key list rather than by spreading and reassigning.
 *
 * The property the codec's suite states over a generated domain follows:
 * `decode(encode(v))` deep-equals `v` for every JSON-representable `v`,
 * envelope-shaped objects included.
 *
 * ## What it does NOT change
 *
 * Decode still accepts a BARE `__type` envelope, so a payload written by
 * `@workflow/world-local`'s own `TypedJsonTransport` — and every row already on
 * the wire when this shipped — decodes exactly as it did. Escaping only ever adds
 * a key spelling no previous encoder produced, which is why the deployment order
 * is decoder-first.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * A key an envelope could be confused with: `__type`, and every escaped form.
 *
 * `__+` is two-or-more underscores — one literal plus a `+` — so this is the
 * whole family at once. Matching the ESCAPED forms too is what makes the scheme
 * total rather than one level deep: without it, an author writing `___type`
 * would collide with the escape of somebody else's `__type`.
 */
const RESERVED_KEY = /^__+type$/;

/**
 * A key that CAME FROM the escape above: three-or-more underscores.
 *
 * Deliberately not {@link RESERVED_KEY}, which also matches the bare `__type` a
 * genuine envelope carries — unescaping that would rename the tag off the
 * codec's own output.
 */
const ESCAPED_KEY = /^___+type$/;

/**
 * The same record with every reserved key renamed one underscore longer, or
 * `undefined` when it holds none.
 *
 * `undefined` rather than the record itself so the caller can tell "nothing to
 * do" from "here is a copy" without an identity comparison, and so the common
 * case — every object in every real payload — allocates nothing.
 */
export function escapeReservedKeys(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return rekey(value, RESERVED_KEY, (key) => `_${key}`);
}

/**
 * The inverse: every escaped key renamed one underscore shorter.
 *
 * Runs on decode AFTER the envelope check, so a genuine `{ __type, data }` has
 * already become a `Uint8Array` and never reaches this.
 */
export function unescapeReservedKeys(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return rekey(value, ESCAPED_KEY, (key) => key.slice(1));
}

/**
 * Rebuild `value` with `rename` applied to every own key matching `pattern`, or
 * `undefined` if none match.
 *
 * The copy is built from scratch rather than spread-and-reassigned: a spread would
 * leave the ORIGINAL key in place beside the renamed one, and with two members of
 * the family in one object the second rename would land on a key the first had
 * just written. Building fresh also keeps insertion order, which is what makes an
 * encode of an object with no reserved key byte-identical to what it was before
 * this existed.
 *
 * **`Object.fromEntries` rather than a loop of `out[key] = …`, because
 * `__proto__` is a real own property on anything `JSON.parse` produced.**
 * Assigning it invokes the prototype SETTER: the key vanishes from the copy and
 * the copy's prototype becomes the author's value. `fromEntries` defines each
 * property instead, so `__proto__` survives as data — which is what it is here.
 * Measured on the three spellings; the assignment loop was the only one that
 * lost it.
 */
function rekey(
  value: Record<string, unknown>,
  pattern: RegExp,
  rename: (key: string) => string,
): Record<string, unknown> | undefined {
  const keys = Object.keys(value);
  if (!keys.some((key) => pattern.test(key))) return undefined;
  return Object.fromEntries(
    keys.map((key) => [pattern.test(key) ? rename(key) : key, value[key]] as const),
  );
}

/**
 * {@link unescapeReservedKeys} for a value the reviver has not yet narrowed.
 *
 * `isRecord` excludes arrays by design, which is wanted here: an array's keys are
 * indices and can never be reserved.
 */
export function unescapeIfRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return unescapeReservedKeys(value) ?? value;
}
