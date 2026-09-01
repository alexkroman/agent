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
    "__proto__",
    "toJSON",
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
    "aGVsbG8=",
    "AAB=",
    "aGVsbG8",
    "not base64 at all!!",
    "2020-01-01T00:00:00.000Z",
    "garbage",
    "",
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
  );

  /** A recursive value over a chosen leaf set. */
  const treeOf = (leaf: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> =>
    fc.letrec<{ node: unknown }>((tie) => ({
      node: fc.oneof(
        { maxDepth: 3, depthSize: "small" },
        leaf,
        envelopeShape,
        fc.array(tie("node"), { maxLength: 4 }),
        fc
          .array(fc.tuple(fc.constantFrom(...KEY_POOL), tie("node")), { maxLength: 4 })
          .map((entries) => recordOf(entries)),
      ),
    })).node;

  const plainTree = treeOf(jsonLeaf);
  const binaryTree = treeOf(fc.oneof(jsonLeaf, binaryLeaf));
  const storageTree = treeOf(fc.oneof(jsonLeaf, binaryLeaf, dateLeaf));

  /** What the generator actually reached, floored at the bottom of the block. */
  const seen = new Map<string, number>();
  const note = (what: string): void => seen.set(what, (seen.get(what) ?? 0) + 1);

  /** Walk a generated value and record which interesting states it contains. */
  function census(value: unknown): void {
    if (value instanceof Uint8Array) {
      note("binary");
      return;
    }
    if (value instanceof Date) {
      note("date");
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) census(item);
      return;
    }
    if (isRecord(value)) censusRecord(value);
  }

  /** {@link census} for a record: the shapes worth counting all live on one. */
  function censusRecord(value: Record<string, unknown>): void {
    const keys = Object.keys(value);
    if (keys.includes("__type")) note("reservedKey");
    if (keys.includes("___type")) note("escapedKey");
    if (keys.includes("__proto__")) note("protoKey");
    if (value.__type === "Uint8Array" && typeof value.data === "string") note("forgedBinary");
    if (value.__type === "Date" && typeof value.iso === "string") note("forgedDate");
    for (const key of keys) census(value[key]);
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

  test("binary AND dates survive the storage codec, together", () => {
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
    // Ranges are over 12 runs (2026-08-31), each summing the four properties
    // 8,000 generated values; every floor sits at roughly half the observed
    // MINIMUM rather than a fraction of the mean. The counts here are unusually
    // tight for this repo because each number is already an average over
    // thousands of draws — a per-run walk is what has the long left tail.
    expect(count("reservedKey"), "never generated a __type key").toBeGreaterThan(1200); // 2311-2420
    expect(count("escapedKey"), "never generated an escaped key").toBeGreaterThan(700); // 1408-1524
    expect(count("protoKey"), "never generated a __proto__ key").toBeGreaterThan(250); // 535-634
    // The two that matter most, and the two the first draft of this block reached
    // ZERO times — see `envelopeShape`.
    expect(count("forgedBinary"), "never forged a binary envelope").toBeGreaterThan(140); // 284-319
    expect(count("forgedDate"), "never forged a date envelope").toBeGreaterThan(200); // 408-482
    expect(count("binary"), "never generated real binary").toBeGreaterThan(1200); // 2318-2578
    expect(count("date"), "never generated a real Date").toBeGreaterThan(450); // 899-1040
  });
});
