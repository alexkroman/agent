// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pure stream helpers in pipeline-stream.ts. Turn-level
// behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { describe, expect, test } from "vitest";
import { countWords, utteranceLooksComplete } from "./pipeline-stream.ts";

describe("countWords", () => {
  test("counts whitespace-delimited words, ignoring extra whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("hello")).toBe(1);
    expect(countWords("  hello   world  ")).toBe(2);
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
