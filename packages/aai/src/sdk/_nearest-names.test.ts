// Copyright 2026 the AAI authors. MIT license.
/**
 * The suggestion half of an unrecognised-name warning, tested on its own.
 *
 * `assemblyai.test.ts` covers the sentence a reader sees; these are the ranking
 * rules that sentence rests on, and a spec written for the caller would pin
 * them only incidentally — which is what `check:module-tests` is about.
 */

import { describe, expect, test } from "vitest";
import { nearestNames } from "./_nearest-names.ts";

const VOICES = ["alba", "anna", "charles", "eve", "jane", "michael", "estelle"];

describe("nearestNames", () => {
  test("names the voice a typo meant", () => {
    // The two real cases the caller was written for: a dropped interior letter
    // and a transposed pair.
    expect(nearestNames("michal", VOICES)).toEqual(["michael"]);
    expect(nearestNames("estele", VOICES)).toEqual(["estelle"]);
  });

  test("says nothing when nothing is close", () => {
    // The bound is the point: past it the "nearest" name is a DIFFERENT voice,
    // and offering one would be worse than saying look it up.
    expect(nearestNames("voice-shipped-last-week", VOICES)).toEqual([]);
    expect(nearestNames("", VOICES)).toEqual([]);
  });

  test("case does not matter on either side", () => {
    expect(nearestNames("MICHAL", VOICES)).toEqual(["michael"]);
    expect(nearestNames("Anna", ["ANNA"])).toEqual(["ANNA"]);
  });

  test("an exact name is its own nearest, at distance zero", () => {
    expect(nearestNames("jane", VOICES)).toEqual(["jane"]);
  });

  test("caps the list, closest first and ties alphabetical", () => {
    // Four names one edit from "aaa": the cap keeps a warning from becoming the
    // haystack again, and the tie-break makes the line deterministic to assert.
    const many = ["aab", "aac", "aad", "aae"];
    expect(nearestNames("aaa", many)).toEqual(["aab", "aac", "aad"]);
  });

  test("distance orders the list before the alphabet does", () => {
    // "aa" is two edits from "aaaa" and one from "aaa", so the closer name wins
    // even though it sorts later.
    expect(nearestNames("aa", ["aaaa", "aaa"])).toEqual(["aaa", "aaaa"]);
  });

  test("an empty catalog is not an error", () => {
    expect(nearestNames("michael", [])).toEqual([]);
  });
});
