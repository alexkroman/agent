// Copyright 2026 the AAI authors. MIT license.
/**
 * The codec's round trip, over a GENERATED domain rather than a hand-listed one.
 *
 * `workflow-typed-json.test.ts` beside this file holds the named cases — each one
 * a bug that shipped. This file is the half with forward power, and it is split
 * out because the two answer different questions: a pin says "this exact value
 * still works", a property says "no value breaks it".
 *
 * The module's own doc has always said "the property that matters is a ROUND
 * TRIP", and the suite then checked that property against a domain somebody typed
 * out by hand. So the codec only ever survived values somebody had thought of,
 * and the two defects it shipped — a `Date` becoming `NaN`, a `Buffer` inside an
 * ARRAY — were both values nobody had typed. The envelope forgery this file was
 * written for is a third of the same kind.
 *
 * A fourth arrived with the `Map`/`Set` envelopes, and it is what the generated
 * domain is for rather than a case list: a `Map` whose KEY is a `Uint8Array`, a
 * `Map` inside a `Set` inside a record whose own key is `__proto__`, an
 * author's `{ __type: "Map", entries: [] }` at depth. `treeOf`'s `collections`
 * parameter generates the first two by construction and `envelopeShape` the
 * third; nobody would have typed any of them out.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  decodeStorageJson,
  decodeTypedJson,
  encodeStorageJson,
  encodeTypedJson,
} from "./workflow-typed-json.ts";

/** Encode then decode, which is what crossing the wire does. */
const roundTrip = (value: unknown): unknown => decodeTypedJson(encodeTypedJson(value));

/** The same, over the storage RPC's codec, which also carries dates. */
const storageRoundTrip = (value: unknown): unknown => decodeStorageJson(encodeStorageJson(value));

describe("round-trip totality over a generated domain", () => {
  /**
   * Keys a generated record draws from.
   *
   * The reserved family and its near-misses are the point. `__proto__` is here
   * because `JSON.parse` makes it a real own property while `out[key] = …` on an
   * object literal invokes the prototype SETTER — so any codec that rebuilds a
   * parsed object key-by-key silently drops it and repoints its own prototype.
   */
  const KEY_POOL = [
    "a",
    "input",
    "__type",
    "___type",
    "____type",
    "_type",
    "type",
    "data",
    "iso",
    // The two payload keys of the collection envelopes, so a record drawn from
    // this pool can carry a complete forgery of one and not merely its tag.
    "entries",
    "values",
    "__proto__",
    "toJSON",
    // A key `jsonb` cannot store: a key is a string, so it carries the same
    // hazard as a value and cannot be enveloped out of it.
    "a\u0000b",
    "\u0001",
  ] as const;

  /**
   * String leaves, weighted so that a record drawn from {@link KEY_POOL} lands on
   * a complete envelope shape often enough to matter.
   *
   * The base64 entries cover both sides of the strict decoder: `"aGVsbG8="` is
   * canonical, `"AAB="` has non-zero trailing bits, `"aGVsbG8"` is unpadded and
   * `"not base64 at all!!"` is not base64 at all. All four are ordinary strings
   * when they arrive as author data, and the property is that they stay that way.
   */
  const STRING_POOL = [
    "Uint8Array",
    "Date",
    "Map",
    "Set",
    "aGVsbG8=",
    "AAB=",
    "aGVsbG8",
    "not base64 at all!!",
    "2020-01-01T00:00:00.000Z",
    "garbage",
    "",
    // The three code units PostgreSQL cannot store, plus the escape's own
    // sentinel and a well-formed pair that must be left ALONE. A `jsonb` column
    // rejects the first three outright, so before the second escape existed a
    // step returning any of them was a retryable 503 for a value that could
    // never be accepted — and the memory backend took them happily, so the
    // divergence was `aai dev` works / deployed fails.
    "nul\u0000inside",
    "\uD83D",
    "lone\uDC4Btail",
    "esc\u0001aped",
    "\u0001u0000",
    "wave 👋 pair",
  ] as const;

  /**
   * A record built with `Object.fromEntries` rather than by assignment.
   *
   * Same reason the codec's own rebuild uses it: an assignment loop would give
   * the GENERATOR a mutated prototype and a missing `__proto__` key, so the
   * property would be comparing against a value that had already lost the thing
   * it exists to check.
   */
  const recordOf = (entries: readonly (readonly [string, unknown])[]): Record<string, unknown> =>
    Object.fromEntries(entries);

  /** JSON-representable values, with no `Uint8Array` or `Date` in them. */
  const jsonLeaf = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1000, max: 1000 }),
    // `-0` is excluded rather than filtered late: `JSON.stringify(-0)` is `"0"`,
    // so it is JSON that cannot carry it, not this codec that loses it — and
    // vitest's `toEqual` distinguishes the two, so it would read as a failure.
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
    fc.constantFrom(...STRING_POOL),
    fc.string(),
  );

  /** The same, plus the two types the codecs exist to carry. */
  const binaryLeaf = fc.uint8Array({ maxLength: 8 });
  const dateLeaf = fc
    .integer({ min: -(2 ** 40), max: 2 ** 40 })
    .map((ms) => new Date(ms))
    .filter((d) => !Number.isNaN(d.getTime()));

  /**
   * An author's object built to look EXACTLY like the codec's own output.
   *
   * **This arbitrary exists because the coverage floor caught its absence.** A
   * complete envelope needs two particular keys carrying two particular values in
   * one record, and drawing that from {@link KEY_POOL} and {@link STRING_POOL} by
   * chance is rare enough that 8,000 generated values produced ZERO — the first
   * run of this block floored `forgedBinary` at `> 0` and failed on it. The
   * round-trip properties were all green at the time, over a domain that never
   * once contained the value the whole block was written to check.
   *
   * That is the floors earning their place, and the reason the rule is to floor a
   * state rather than to trust that a generator reaches it: without the floor this
   * suite would have read as a proof of exactly the property it was not testing.
   *
   * The escaped spellings are here for the other direction — an author who writes
   * `___type` HIMSELF must get `___type` back, which is the case a one-level
   * escape scheme quietly corrupts.
   */
  const envelopeShape = fc.oneof(
    fc.record({
      __type: fc.constantFrom("Uint8Array", "Date", "Buffer"),
      data: fc.constantFrom(...STRING_POOL),
    }),
    fc.record({
      __type: fc.constantFrom("Date", "Uint8Array"),
      iso: fc.constantFrom(...STRING_POOL),
    }),
    fc.record({
      ___type: fc.constantFrom("Uint8Array", "Date"),
      data: fc.constantFrom(...STRING_POOL),
    }),
    fc.record({
      ____type: fc.constant("Uint8Array"),
      iso: fc.constantFrom(...STRING_POOL),
    }),
    // ONE record forges both collection envelopes, the tag deciding which: with
    // `__type: "Map"` the array `entries` completes it and `values` rides along
    // as an extra field, and the other way round for `Set`. Two birds, and the
    // extra field is a case of its own — a reviver that matched on the key SET
    // rather than structurally would treat this differently.
    fc.record({
      __type: fc.constantFrom("Map", "Set"),
      entries: fc.array(fc.constantFrom(...STRING_POOL), { maxLength: 2 }),
      values: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 2 }),
    }),
    // A HALF-match, which must stay ordinary data on both codecs: the tag is
    // right and the payload is not an array, so no envelope guard may fire.
    fc.record({
      __type: fc.constantFrom("Map", "Set"),
      entries: fc.constantFrom(...STRING_POOL),
      values: fc.constantFrom(...STRING_POOL),
    }),
    fc.record({
      ___type: fc.constantFrom("Map", "Set"),
      entries: fc.array(fc.constantFrom(...STRING_POOL), { maxLength: 2 }),
    }),
  );

  /**
   * A recursive value over a chosen leaf set.
   *
   * `collections` gates `Map`/`Set` NODES rather than a leaf, deliberately: a
   * collection's members are ordinary generated values, which is the whole
   * point — a `Map` inside a `Set`, bytes as a KEY, a date as a value, all
   * without listing a single one of those shapes.
   *
   * It is a PARAMETER because the two codecs differ on exactly this. The
   * storage codec carries collections and the queue codec deliberately does
   * not (see the module doc: its far end is not ours), so putting a real `Map`
   * on the queue tree would be generating a value that codec never claimed to
   * survive — a generator breaking its own contract, and the failure would
   * read as a finding.
   */
  const treeOf = (leaf: fc.Arbitrary<unknown>, collections = false): fc.Arbitrary<unknown> =>
    fc.letrec<{ node: unknown }>((tie) => {
      const nodes: fc.Arbitrary<unknown>[] = [
        leaf,
        envelopeShape,
        fc.array(tie("node"), { maxLength: 4 }),
        fc
          .array(fc.tuple(fc.constantFrom(...KEY_POOL), tie("node")), { maxLength: 4 })
          .map((entries) => recordOf(entries)),
      ];
      if (collections) {
        nodes.push(
          fc
            .array(fc.tuple(tie("node"), tie("node")), { maxLength: 3 })
            .map((entries) => new Map(entries)),
          fc.array(tie("node"), { maxLength: 3 }).map((items) => new Set(items)),
        );
      }
      return { node: fc.oneof({ maxDepth: 3, depthSize: "small" }, ...nodes) };
    }).node;

  const plainTree = treeOf(jsonLeaf);
  const binaryTree = treeOf(fc.oneof(jsonLeaf, binaryLeaf));
  const storageTree = treeOf(fc.oneof(jsonLeaf, binaryLeaf, dateLeaf), true);

  /** What the generator actually reached, floored at the bottom of the block. */
  const seen = new Map<string, number>();
  const note = (what: string): void => {
    seen.set(what, (seen.get(what) ?? 0) + 1);
  };

  /**
   * Does this string hold a code unit `jsonb` refuses?
   *
   * Spelled out rather than imported from the module under test, so the census
   * cannot agree with a broken scanner — the floors below are the only thing
   * standing between a live property and a decorative one.
   */
  const isHigh = (code: number): boolean => code >= 0xd8_00 && code <= 0xdb_ff;
  const isLow = (code: number): boolean => code >= 0xdc_00 && code <= 0xdf_ff;

  function isUnstorable(value: string): boolean {
    for (let at = 0; at < value.length; at += 1) {
      const code = value.charCodeAt(at);
      if (code === 0 || code === 1) return true;
      // A well-formed PAIR is storable and is consumed whole; `charCodeAt` past
      // the end is `NaN`, so a trailing high surrogate falls through as lone.
      if (isHigh(code) && isLow(value.charCodeAt(at + 1))) {
        at += 1;
        continue;
      }
      if (isHigh(code) || isLow(code)) return true;
    }
    return false;
  }

  /**
   * The LEAF kinds, counted here and nowhere else.
   *
   * Answers whether the value was one, so {@link census} reads as leaf-then-
   * container rather than as one chain of seven `instanceof`s.
   */
  function censusLeaf(value: unknown): boolean {
    if (typeof value === "string") {
      if (isUnstorable(value)) note("unstorableString");
      return true;
    }
    if (value instanceof Uint8Array) {
      note("binary");
      return true;
    }
    if (value instanceof Date) {
      note("date");
      return true;
    }
    return false;
  }

  /** Walk a generated value and record which interesting states it contains. */
  function census(value: unknown): void {
    if (censusLeaf(value)) return;
    // Before the `isRecord` branch, which answers TRUE for both — `Object.keys`
    // of a `Map` is empty, so a collection walked as a record is counted as
    // nothing and its members are never reached.
    if (value instanceof Map || value instanceof Set) {
      censusCollection(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) census(item);
      return;
    }
    if (isRecord(value)) censusRecord(value);
  }

  /** {@link census} for a collection: counted, then walked through its members. */
  function censusCollection(value: Map<unknown, unknown> | Set<unknown>): void {
    if (value instanceof Set) {
      note("set");
      for (const item of value) census(item);
      return;
    }
    note("map");
    for (const [key, item] of value) {
      census(key);
      census(item);
    }
  }

  /**
   * The record shapes worth counting: a key the escape has to cover, or a
   * COMPLETE envelope forgery — the tag AND a payload of the right kind in ONE
   * record, which is exactly what the codec's guards match on.
   *
   * A TABLE rather than a run of `if`s because the eighth entry is what tipped
   * `censusRecord` over biome's cognitive-complexity ceiling, and a list of
   * predicates is what this always was.
   *
   * `Object.hasOwn` rather than `in`: `__proto__` is on every object's
   * prototype chain, so `"__proto__" in value` is true for all of them and
   * would count the one state this file exists to distinguish as universal.
   */
  const RECORD_STATES: readonly (readonly [string, (v: Record<string, unknown>) => boolean])[] = [
    ["reservedKey", (v) => Object.hasOwn(v, "__type")],
    ["escapedKey", (v) => Object.hasOwn(v, "___type")],
    ["protoKey", (v) => Object.hasOwn(v, "__proto__")],
    ["forgedBinary", (v) => v.__type === "Uint8Array" && typeof v.data === "string"],
    ["forgedDate", (v) => v.__type === "Date" && typeof v.iso === "string"],
    ["forgedMap", (v) => v.__type === "Map" && Array.isArray(v.entries)],
    ["forgedSet", (v) => v.__type === "Set" && Array.isArray(v.values)],
    ["unstorableKey", (v) => Object.keys(v).some(isUnstorable)],
  ];

  /** {@link census} for a record: the shapes worth counting all live on one. */
  function censusRecord(value: Record<string, unknown>): void {
    for (const [what, matches] of RECORD_STATES) {
      if (matches(value)) note(what);
    }
    for (const key of Object.keys(value)) census(value[key]);
  }

  const RUNS = 2000;

  test("every JSON value survives the QUEUE codec unchanged", () => {
    fc.assert(
      fc.property(plainTree, (value) => {
        census(value);
        expect(roundTrip(value)).toEqual(value);
      }),
      { numRuns: RUNS },
    );
  });

  test("every JSON value survives the STORAGE codec unchanged", () => {
    fc.assert(
      fc.property(plainTree, (value) => {
        expect(storageRoundTrip(value)).toEqual(value);
      }),
      { numRuns: RUNS },
    );
  });

  test("binary survives the queue codec beside envelope-shaped author data", () => {
    fc.assert(
      fc.property(binaryTree, (value) => {
        census(value);
        expect(roundTrip(value)).toEqual(value);
      }),
      { numRuns: RUNS },
    );
  });

  test("binary, dates AND collections survive the storage codec, together", () => {
    fc.assert(
      fc.property(storageTree, (value) => {
        census(value);
        expect(storageRoundTrip(value)).toEqual(value);
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * A metamorphic relation, which needs no oracle: whatever `decode` gives back
   * must re-encode to the same bytes.
   *
   * It catches an asymmetry the round trip alone cannot — a decode that loses
   * information the encoder would have spelled differently, and any escape that
   * is not exactly inverted. `toEqual` compares structure; this compares the
   * wire.
   */
  test("encode is stable across a decode, on both codecs", () => {
    fc.assert(
      fc.property(storageTree, (value) => {
        const once = encodeStorageJson(value);
        expect(encodeStorageJson(decodeStorageJson(once))).toBe(once);
      }),
      { numRuns: RUNS },
    );
    fc.assert(
      fc.property(binaryTree, (value) => {
        const once = encodeTypedJson(value);
        expect(encodeTypedJson(decodeTypedJson(once))).toBe(once);
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * Coverage floors — see AGENTS.md, "Property tests run on fast-check". Each sits
   * UNDER the observed minimum across the recorded number of runs, not at a
   * fraction of the mean: what a generator reaches is correlated within a run, so
   * these distributions have long left tails.
   */
  test("the generator actually reached the states that matter", () => {
    const count = (what: string): number => seen.get(what) ?? 0;
    // Ranges are over 13 runs (2026-09-02), each summing the four properties
    // 8,000 generated values; every floor sits at roughly half the observed
    // MINIMUM rather than a fraction of the mean. The counts here are unusually
    // tight for this repo because each number is already an average over
    // thousands of draws — a per-run walk is what has the long left tail.
    //
    // **Every range was RE-MEASURED when the collection envelopes landed, and
    // four floors moved — two of them DOWN.** Widening `KEY_POOL`,
    // `STRING_POOL` and `envelopeShape` makes each individual state rarer per
    // draw even though the domain is strictly better: `forgedBinary` fell from
    // 284-319 to 156-195 and `forgedDate` from 408-482 to 223-269, so both old
    // floors sat inside 10% of the new minimum and were flakes waiting for an
    // unlucky seed. A floor that has to be lowered because the DOMAIN grew is
    // not the same thing as one lowered to make a run pass, and the way to tell
    // is that the ranges are recorded: the counts here are still hundreds.
    expect(count("reservedKey"), "never generated a __type key").toBeGreaterThan(1200); // 2404-2576
    expect(count("escapedKey"), "never generated an escaped key").toBeGreaterThan(700); // 1402-1569
    expect(count("protoKey"), "never generated a __proto__ key").toBeGreaterThan(220); // 452-525
    // The forgeries, and the states the first draft of this block reached ZERO
    // times — see `envelopeShape`.
    expect(count("forgedBinary"), "never forged a binary envelope").toBeGreaterThan(75); // 156-195
    expect(count("forgedDate"), "never forged a date envelope").toBeGreaterThan(110); // 223-269
    expect(count("forgedMap"), "never forged a Map envelope").toBeGreaterThan(110); // 232-273
    expect(count("forgedSet"), "never forged a Set envelope").toBeGreaterThan(110); // 236-276
    expect(count("binary"), "never generated real binary").toBeGreaterThan(1500); // 3211-3416
    expect(count("date"), "never generated a real Date").toBeGreaterThan(800); // 1740-1978
    // The two collection floors are ONE property's worth rather than four —
    // only the storage tree carries collections, for the reason `treeOf`'s
    // `collections` parameter gives — which is why they run below the counts
    // above them and not because they are reached less often.
    expect(count("map"), "never generated a real Map").toBeGreaterThan(500); // 1020-1151
    expect(count("set"), "never generated a real Set").toBeGreaterThan(500); // 1051-1151
    // The two states the SECOND escape exists for. Both are drawn from a pool, so
    // they are reached constantly — the floors are here to catch a pool entry
    // deleted or a scanner that stopped recognising one, not to pin a rate.
    expect(count("unstorableString"), "never generated an unstorable string").toBeGreaterThan(600); // 1450-1491 over 5 runs
    expect(count("unstorableKey"), "never generated an unstorable key").toBeGreaterThan(300); // 844-860 over 5 runs
  });
});
