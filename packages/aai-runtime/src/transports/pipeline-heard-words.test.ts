// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the heard cursor's word alignment. The cursor built on it is
// specced in pipeline-heard.test.ts.

import type { TtsWordTiming } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { alignedEnd, alignWords, lastHeardWord, snapToWord } from "./pipeline-heard-words.ts";

const word = (text: string, startMs: number, endMs: number): TtsWordTiming => ({
  text,
  startMs,
  endMs,
});

describe("alignWords", () => {
  test("each reported word maps to the offset just past it in the text", () => {
    expect(alignWords("Hello there, friend.", [word("hello", 0, 1), word("there", 1, 2)])).toEqual([
      5, 11,
    ]);
  });

  test("punctuation and case the provider normalized away still align", () => {
    expect(alignWords("It costs 5.00, Dr. Smith", [word("500", 0, 1), word("dr", 1, 2)])).toEqual([
      13, 17,
    ]);
  });

  test("a word the text does not hold is recorded as a miss, not fatal", () => {
    expect(alignWords("five dollars", [word("$5", 0, 1), word("dollars", 1, 2)])).toEqual([-1, 12]);
  });
});

describe("lastHeardWord", () => {
  const words = [word("a", 0, 400), word("b", 400, 800)];

  test("only a word whose audio WHOLLY elapsed counts", () => {
    expect(lastHeardWord(words, 399)).toBe(-1);
    expect(lastHeardWord(words, 600)).toBe(0);
    expect(lastHeardWord(words, 800)).toBe(1);
  });
});

describe("alignedEnd", () => {
  test("falls back to the last aligned word at or before the heard one", () => {
    expect(alignedEnd([5, -1, -1], 2)).toBe(5);
    expect(alignedEnd([-1, -1], 1)).toBe(-1);
  });
});

describe("snapToWord", () => {
  test("a cut inside a word moves back to the boundary before it", () => {
    expect(snapToWord("Hello there friend", 9)).toBe(5);
  });

  test("a cut on a boundary or past the end is kept as is", () => {
    expect(snapToWord("Hello there friend", 5)).toBe(5);
    expect(snapToWord("Hello there", 40)).toBe(11);
  });

  test("a cut inside the first word has no boundary to snap to", () => {
    expect(snapToWord("Hello there", 3)).toBe(3);
  });
});
