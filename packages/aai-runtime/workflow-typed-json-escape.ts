// Copyright 2026 the AAI authors. MIT license.
/**
 * What keeps an author's value STORABLE — and their object from impersonating a
 * tagged envelope.
 *
 * Two escapes, both total and both invertible, applied by the one codec
 * (`workflow-typed-json.ts`) every journal backend goes through. The first is
 * about type confusion and is argued below; the second is about characters
 * PostgreSQL cannot store and is argued at
 * {@link escapeUnstorableCharacters}.
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
  // The exact inverse of `escapeIfPlain`, in reverse order.
  const storable = unescapeUnstorableKeys(value) ?? value;
  return unescapeReservedKeys(storable) ?? storable;
}

/**
 * The escape character both string escapes are built on: `U+0001`.
 *
 * A control character, and that is the point — it is not something a real payload
 * carries, so the fast path below skips almost every string in almost every
 * value. PostgreSQL stores it happily: `U+0000` is the ONLY code point `text`
 * cannot hold, so every other control character is available as a sentinel.
 */
const ESC = "\u0001";
const ESC_CODE = 0x01;

/** Four hex digits, for the surrogate production. `parseInt` alone is NOT this. */
const HEX4 = /^[0-9a-fA-F]{4}$/;

const isHighSurrogate = (code: number): boolean => code >= 0xd8_00 && code <= 0xdb_ff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc_00 && code <= 0xdf_ff;

/**
 * What one code unit becomes, or `undefined` when it is storable as it is.
 *
 * Three productions, and the second and third are one defect wearing two faces:
 *
 * - `U+0000`. `select '"\u0000"'::jsonb` raises `22P05 unsupported Unicode escape
 *   sequence`, because PostgreSQL `text` cannot hold a NUL and `jsonb` is stored
 *   as text.
 * - A lone surrogate, high or low. A JavaScript string is a sequence of UTF-16
 *   code units and may legally hold either; UTF-8 cannot encode one, so Postgres
 *   refuses it the same way. **This is the likelier of the two in real code** —
 *   `"👋".slice(0, 1)` is an unpaired high surrogate, and so is any truncation of
 *   a transcript at a code UNIT boundary rather than a code POINT one.
 * - The escape itself, doubled, which is what makes the map invertible.
 */
function replacementFor(code: number): string | undefined {
  if (code === 0) return `${ESC}0`;
  if (code === ESC_CODE) return ESC + ESC;
  if (isHighSurrogate(code) || isLowSurrogate(code)) {
    return `${ESC}u${code.toString(16).padStart(4, "0")}`;
  }
  return undefined;
}

/**
 * The same string with every code unit PostgreSQL cannot store escaped away.
 *
 * ## The failure this closes
 *
 * The journal's `input`, `output` and a step's `output` are `jsonb` on both
 * database backends, and the codec hands them over as JSON TEXT that Postgres
 * parses. So a step returning a string that held one of the units
 * {@link replacementFor} lists did not merely fail to store: the driver raised a
 * raw SQLSTATE, which is a plain `Error`, which `withReserved` answers with a
 * **503**, which tells the guest to retry a value that can never be accepted. The
 * engine then spent the message's whole attempt budget on it.
 *
 * It was also a three-way DIVERGENCE, which is worse than the error: the MEMORY
 * backend holds JavaScript values and accepts all of this, so a workflow tried
 * under `aai dev` worked and the same workflow deployed failed — the exact shape
 * of gap `journal-conformance.ts` exists to close, and it had no case for it.
 *
 * ## Why it is TOTAL and INJECTIVE, which is the property that matters
 *
 * Every production begins with the escape and the escape itself is doubled, so
 * decode can consume each sequence atomically left to right and recover exactly
 * one input; the identity covers every other code unit. A well-formed surrogate
 * PAIR is skipped whole, so an emoji is untouched — only an unpaired half is a
 * production. And nothing escapes to `__type` or to any key the reserved-key
 * rename above reads, so the two escapes compose in either order.
 *
 * It is a NO-OP for every string holding none of them, which is every string in
 * every real payload: the walk allocates nothing and returns the SAME string.
 *
 * ## A hand-written walk rather than a regex
 *
 * Two reasons, and the first is not style. Biome's `noControlCharactersInRegex`
 * refuses `[\u0000\u0001]` in a pattern, and a suppression here would be one more
 * entry on the escape-hatch ratchet for a rule that is right about ordinary code.
 * The walk is also cheaper than the pattern it replaces: matching a lone
 * surrogate by regex needs a lookahead AND a lookbehind, both evaluated at every
 * position of every string the codec touches.
 *
 * The cost of the whole scheme is that a stored value is no longer byte-identical
 * to what the author returned when it holds one of these units; it round-trips by
 * MEANING, which is the property the journal already promises — `jsonb` normalizes
 * key order and number spelling regardless.
 *
 * A string containing a bare `U+0001` followed by `0` and written by an OLDER
 * encoder would decode to a NUL. Deploy decoder-first, as with the key escape
 * above; the corpus of stored values holding a raw `U+0001` is empty by
 * construction, since the old encoder could not write one into a `jsonb` column
 * without the whole statement failing.
 */
export function escapeUnstorableCharacters(value: string): string {
  let out: string | undefined;
  let copied = 0;
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    // A well-formed pair, skipped WHOLE: `charCodeAt` past the end is `NaN`, which
    // fails the low test, so a trailing high surrogate falls through as lone.
    if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(at + 1))) {
      at += 1;
      continue;
    }
    const replacement = replacementFor(code);
    if (replacement === undefined) continue;
    out = (out ?? "") + value.slice(copied, at) + replacement;
    copied = at + 1;
  }
  if (out === undefined) return value;
  return out + value.slice(copied);
}

/**
 * The inverse of {@link escapeUnstorableCharacters}.
 *
 * A sequence the encoder cannot produce — the escape followed by anything else —
 * is left EXACTLY as it is rather than guessed at, which is what makes reading a
 * value written before either escape existed a no-op. {@link HEX4} is why the
 * surrogate production is validated rather than parsed: `parseInt("0g12", 16)` is
 * `0`, so a `parseInt` alone would turn four arbitrary characters into a NUL —
 * the very unit this exists to keep out.
 */
export function unescapeUnstorableCharacters(value: string): string {
  const first = value.indexOf(ESC);
  if (first < 0) return value;
  let out = value.slice(0, first);
  for (let at = first; at < value.length; at += 1) {
    if (value.charCodeAt(at) !== ESC_CODE) {
      out += value[at];
      continue;
    }
    const marker = value[at + 1];
    if (marker === ESC) {
      out += ESC;
      at += 1;
      continue;
    }
    if (marker === "0") {
      out += "\u0000";
      at += 1;
      continue;
    }
    const hex = value.slice(at + 2, at + 6);
    if (marker === "u" && HEX4.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      at += 5;
      continue;
    }
    out += ESC;
  }
  return out;
}

/**
 * The same record with every KEY made storable, or `undefined` when none needed
 * it.
 *
 * A key is a string, so it carries the same hazard as a value and cannot be
 * enveloped out of it. Independent of the reserved-key rename above and safely
 * composable with it: {@link RESERVED_KEY} is anchored on `_{2,}type`, which holds
 * none of the escapable units, so escaping can never turn an author's key INTO
 * `__type` and renaming can never introduce one.
 */
export function escapeUnstorableKeys(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return rekeyAll(value, escapeUnstorableCharacters);
}

/** The inverse, for decode. */
export function unescapeUnstorableKeys(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return rekeyAll(value, unescapeUnstorableCharacters);
}

/**
 * {@link rekey} for a transform that applies to EVERY key rather than to the ones
 * matching a pattern.
 *
 * Answers `undefined` when the transform changed nothing, so the common case
 * allocates nothing — the same contract, and the same `Object.fromEntries`
 * (`__proto__` is a real own property on anything `JSON.parse` produced).
 */
function rekeyAll(
  value: Record<string, unknown>,
  rename: (key: string) => string,
): Record<string, unknown> | undefined {
  const keys = Object.keys(value);
  const renamed = keys.map(rename);
  if (renamed.every((key, at) => key === keys[at])) return undefined;
  return Object.fromEntries(renamed.map((key, at) => [key, value[keys[at] as string]] as const));
}
