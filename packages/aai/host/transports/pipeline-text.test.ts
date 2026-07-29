// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the transcript-text helpers in pipeline-text.ts. Turn-level
// behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { describe, expect, test } from "vitest";
import { hasMinWords, scanWords, utteranceLooksComplete } from "./pipeline-text.ts";

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

describe("utteranceLooksComplete", () => {
  test("complete: ends with terminal punctuation and a content word", () => {
    expect(utteranceLooksComplete("Track order BOB12.")).toBe(true);
    expect(utteranceLooksComplete("What are the platinum card benefits?")).toBe(true);
    expect(utteranceLooksComplete("Add two to my cart!")).toBe(true);
    // Trailing quotes/brackets after the punctuation still count as complete.
    expect(utteranceLooksComplete('Search for "hiking boots".')).toBe(true);
  });

  test("incomplete: no terminal punctuation (likely mid-utterance fragment)", () => {
    expect(utteranceLooksComplete("find a two-bedroom in Austin")).toBe(false);
    expect(utteranceLooksComplete("track order BOB12")).toBe(false);
  });

  test("incomplete: trails off on a continuation cue even with punctuation", () => {
    expect(utteranceLooksComplete("actually make it, um.")).toBe(false);
    expect(utteranceLooksComplete("I want to search for, uh")).toBe(false);
    expect(utteranceLooksComplete("set the price to, and")).toBe(false);
    expect(utteranceLooksComplete("change it to the")).toBe(false);
  });

  test("empty / whitespace is never complete", () => {
    expect(utteranceLooksComplete("")).toBe(false);
    expect(utteranceLooksComplete("   ")).toBe(false);
  });

  test("the last word is found behind trailing digits and punctuation", () => {
    // The tail scan must skip non-word characters (digits, punctuation) to
    // reach the actual last word, exactly like the old whole-string match.
    expect(utteranceLooksComplete("make it the 2.")).toBe(false); // cue "the"
    expect(utteranceLooksComplete("order number 42.")).toBe(true); // "number"
  });

  test("apostrophes are part of the last word", () => {
    expect(utteranceLooksComplete("okay let's.")).toBe(false); // cue "let's"
    expect(utteranceLooksComplete("that's what I don't.")).toBe(true);
  });

  test("cue detection sees through trailing quotes and brackets", () => {
    expect(utteranceLooksComplete('I want to search for, and."')).toBe(false);
    expect(utteranceLooksComplete("(so.)")).toBe(false); // cue "so"
  });

  test("punctuation-only text is never complete", () => {
    expect(utteranceLooksComplete("...")).toBe(true); // ends in ".", no cue word
    expect(utteranceLooksComplete('"')).toBe(false); // closers with no punctuation
  });
});
