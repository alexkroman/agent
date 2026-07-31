// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the transcript-text helpers in pipeline-text.ts. Turn-level
// behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { describe, expect, test } from "vitest";
import { hasMinWords, scanWords } from "./pipeline-text.ts";

/** Full word count via the exported scan — the oracle `hasMinWords` is checked against. */
const countWords = (text: string): number => scanWords(text, Number.POSITIVE_INFINITY);

/** The `split`-based implementation these helpers replaced, as an oracle. */
const splitCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const SAMPLES = [
  "",
  "   ",
  "hello",
  "  hello   world  ",
  "\t\n\r one two \f",
  "a b",
  "one two　three",
  "yes.",
  "actually, make it two — no, three",
];

describe("countWords", () => {
  test("counts whitespace-delimited words, ignoring extra whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("hello")).toBe(1);
    expect(countWords("  hello   world  ")).toBe(2);
  });

  test("matches split(/\\s+/) across ASCII and Unicode separators", () => {
    for (const text of SAMPLES) {
      expect(countWords(text), JSON.stringify(text)).toBe(splitCount(text));
    }
  });
});

describe("scanWords", () => {
  test("returns min(actual count, cap) — the bounded scan the partial handler relies on", () => {
    for (const text of SAMPLES) {
      const total = splitCount(text);
      for (let cap = 1; cap <= total + 2; cap++) {
        expect(scanWords(text, cap), `${JSON.stringify(text)} cap ${cap}`).toBe(
          Math.min(total, cap),
        );
      }
    }
  });

  test("stops at the cap on a long transcript", () => {
    expect(scanWords("one two three four five six", 2)).toBe(2);
  });
});

describe("hasMinWords", () => {
  test("agrees with countWords at every threshold", () => {
    for (const text of SAMPLES) {
      const total = splitCount(text);
      for (let min = 0; min <= total + 2; min++) {
        expect(hasMinWords(text, min), `${JSON.stringify(text)} >= ${min}`).toBe(total >= min);
      }
    }
  });

  test("a non-positive threshold is always satisfied", () => {
    expect(hasMinWords("", 0)).toBe(true);
    expect(hasMinWords("", -1)).toBe(true);
  });
});
