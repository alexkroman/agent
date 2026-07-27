// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the transcript-text helpers in pipeline-text.ts. Turn-level
// behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { describe, expect, test } from "vitest";
import { countWords, hasMinWords, hasSpeech, utteranceLooksComplete } from "./pipeline-text.ts";

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

describe("hasSpeech", () => {
  test("true only when a non-whitespace character is present", () => {
    for (const text of SAMPLES) {
      expect(hasSpeech(text), JSON.stringify(text)).toBe(text.trim().length > 0);
    }
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
});
