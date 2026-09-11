// Copyright 2026 the AAI authors. MIT license.
/**
 * The keyterm rules, stated against the two service limits that make them
 * load-bearing: an over-long term is IGNORED (so dropping it costs nothing but
 * says so) and an over-long LIST is refused at connect (so not dropping it
 * would take the agent off the air).
 */

import { describe, expect, test } from "vitest";
import {
  describeKeytermDrops,
  MAX_KEYTERM_CHARS,
  MAX_KEYTERMS,
  normalizeKeyterms,
} from "./keyterms.ts";

describe("normalizeKeyterms", () => {
  test("keeps a declared list unchanged, in order", () => {
    const terms = ["Acme Rewards", "SKU", "wireless earbuds"];
    expect(normalizeKeyterms(terms)).toEqual({ terms, dropped: [] });
  });

  test("trims, and drops a term that was only whitespace", () => {
    const { terms, dropped } = normalizeKeyterms(["  Acme Rewards  ", "   "]);
    expect(terms).toEqual(["Acme Rewards"]);
    expect(dropped).toEqual([{ term: "   ", reason: "empty" }]);
  });

  test("de-duplicates case-INSENSITIVELY and keeps the FIRST spelling", () => {
    // The two rules together: a later stray-cased copy is the accident, and
    // the casing an author wrote first is what they want in the transcript.
    const { terms, dropped } = normalizeKeyterms(["AssemblyAI", "assemblyai", "ASSEMBLYAI"]);
    expect(terms).toEqual(["AssemblyAI"]);
    expect(dropped.map((d) => d.reason)).toEqual(["duplicate", "duplicate"]);
  });

  test(`drops a term over ${MAX_KEYTERM_CHARS} characters — the service ignores it anyway`, () => {
    const long = "x".repeat(MAX_KEYTERM_CHARS + 1);
    const { terms, dropped } = normalizeKeyterms(["ok", long]);
    expect(terms).toEqual(["ok"]);
    expect(dropped).toEqual([{ term: long, reason: "too-long" }]);
    // The boundary is inclusive: exactly the cap is legal.
    expect(normalizeKeyterms(["y".repeat(MAX_KEYTERM_CHARS)]).dropped).toEqual([]);
  });

  test(`caps the list at ${MAX_KEYTERMS} — over it the CONNECT fails`, () => {
    const many = Array.from({ length: MAX_KEYTERMS + 5 }, (_, i) => `term-${i}`);
    const { terms, dropped } = normalizeKeyterms(many);
    expect(terms).toHaveLength(MAX_KEYTERMS);
    expect(terms.at(-1)).toBe(`term-${MAX_KEYTERMS - 1}`);
    expect(dropped).toHaveLength(5);
    expect(dropped.every((d) => d.reason === "over-cap")).toBe(true);
  });

  test("is TOTAL — every input term is kept or dropped, exactly once", () => {
    const input = ["a", "a", "", "b".repeat(80), ...Array.from({ length: 120 }, (_, i) => `t${i}`)];
    const { terms, dropped } = normalizeKeyterms(input);
    expect(terms.length + dropped.length).toBe(input.length);
  });
});

describe("describeKeytermDrops", () => {
  test("is undefined when nothing was dropped", () => {
    expect(describeKeytermDrops([])).toBeUndefined();
  });

  test("groups by reason and quotes each term", () => {
    const { dropped } = normalizeKeyterms(["Acme", "acme", "   "]);
    // The empty drop quotes the RAW term, whitespace included: an author
    // hunting a stray entry in a list needs to see what was actually there.
    expect(describeKeytermDrops(dropped)).toBe('duplicate: "acme"; empty: "   "');
  });
});
