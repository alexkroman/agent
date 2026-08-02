// Copyright 2026 the AAI authors. MIT license.
// The hero shows a random sample of the starter catalog, not all of it —
// these pin the sample's size, uniqueness, and provenance.

import { describe, expect, test } from "vitest";
import { STARTERS, sampleStarters } from "./starters.ts";

describe("sampleStarters", () => {
  test("returns the requested count of distinct catalog entries", () => {
    const picked = sampleStarters(5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((s) => s.label)).size).toBe(5);
    for (const starter of picked) expect(STARTERS).toContain(starter);
  });

  test("caps at the catalog size instead of repeating", () => {
    const picked = sampleStarters(STARTERS.length + 10);
    expect(picked).toHaveLength(STARTERS.length);
  });

  test("is deterministic for a fixed random source", () => {
    const zeros = sampleStarters(3, () => 0);
    // random() = 0 always picks the pool head: the first three in order.
    expect(zeros).toEqual(STARTERS.slice(0, 3));
  });
});
