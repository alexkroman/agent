// Copyright 2026 the AAI authors. MIT license.
// The hero shows a random sample of the starter catalog, not all of it —
// these pin the sample's size, uniqueness, and provenance.

import { describe, expect, test } from "vitest";
import { STARTERS, sampleStarters } from "./starters.ts";

describe("sampleStarters", () => {
  test("returns the requested count of distinct catalog entries", () => {
    const picked = sampleStarters(STARTERS, 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((s) => s.label)).size).toBe(5);
    for (const starter of picked) expect(STARTERS).toContain(starter);
  });

  test("caps at the catalog size instead of repeating", () => {
    const picked = sampleStarters(STARTERS, STARTERS.length + 10);
    expect(picked).toHaveLength(STARTERS.length);
  });

  test("is deterministic for a fixed random source", () => {
    const zeros = sampleStarters(STARTERS, 3, () => 0);
    // random() = 0 always picks the pool head: the first three in order.
    expect(zeros).toEqual(STARTERS.slice(0, 3));
  });

  test("does not mutate the catalog it samples from", () => {
    // The pool is spread before splicing; without that, one page load would
    // empty the module-level catalog for the rest of the session.
    const before = STARTERS.length;
    sampleStarters(STARTERS, 5);
    expect(STARTERS).toHaveLength(before);
  });
});

describe("the catalog", () => {
  test("has enough entries to fill the hero's sample", () => {
    expect(STARTERS.length).toBeGreaterThanOrEqual(5);
  });

  test("names no workflow-app template", () => {
    // Every project is a voice agent; the workflow-app templates are not offered.
    const named = STARTERS.flatMap((s) =>
      [...s.prompt.matchAll(/use the (\S+) template/gi)].map((m) => m[1]),
    );
    expect(named).not.toContain("transcription-workflow");
    expect(named).not.toContain("link-digest-workflow");
    expect(named).not.toContain("spoken-summary-workflow");
  });
});
