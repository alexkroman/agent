// Copyright 2026 the AAI authors. MIT license.
/**
 * `_template-support.ts`'s two helpers are duplicated from
 * `aai-gates/_gate-support.ts` rather than imported across the package
 * boundary, so they need a test of their own here: the copy that is not
 * covered is the copy that quietly stops matching.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, sole } from "./_template-support.ts";

describe("byCodeUnit", () => {
  test("orders by UTF-16 code unit, not by locale", () => {
    // The whole reason the comparator is explicit: `localeCompare` puts these
    // in the other order under most ICU collations, and a gate reading a
    // sorted list would then report a locale difference as a change.
    expect(["b", "B", "a", "A"].sort(byCodeUnit)).toEqual(["A", "B", "a", "b"]);
  });

  test("reports equality as 0, so a stable sort stays stable", () => {
    expect(byCodeUnit("x", "x")).toBe(0);
  });

  test("is antisymmetric", () => {
    expect(byCodeUnit("a", "b")).toBe(-1);
    expect(byCodeUnit("b", "a")).toBe(1);
  });
});

describe("sole", () => {
  test("returns the one value of a single-entry namespace", () => {
    expect(sole({ default: 42 })).toBe(42);
  });

  test("returns undefined for an empty namespace", () => {
    // The load-bearing case: a glob that stopped resolving yields `{}`, and a
    // caller asserting on `undefined` fails rather than asserting on nothing.
    expect(sole({})).toBeUndefined();
  });
});
