// Copyright 2026 the AAI authors. MIT license.
/**
 * Every documented output shape, pinned to the character.
 *
 * These are formatters whose whole contract IS the string, and whose reason for
 * existing is that four private copies of each had drifted apart — so an
 * assertion on anything looser than the exact output would let the same drift
 * back in.
 */
import { describe, expect, test } from "vitest";
import { countWords, formatBytes, formatDuration, plural } from "./format.ts";

describe("formatBytes", () => {
  test.each([
    [0, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    // The unit steps at exactly 1024, not at 1000.
    [1024, "1 KB"],
    [112_640, "110 KB"],
    // `call-audit/workflows/summarize.ts` printed KB whole, and still does.
    [1_048_575, "1.0 MB"],
    [1_048_576, "1.0 MB"],
    // The shape the four `mb()` copies produced, to one decimal.
    [18_559_795, "17.7 MB"],
    [2_097_152, "2.0 MB"],
    [1_073_741_824, "1.0 GB"],
    [1_099_511_627_776, "1.0 TB"],
    // Past the largest unit it keeps counting in it rather than inventing one.
    [1_125_899_906_842_624, "1024.0 TB"],
  ])("formats %d as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  test("rounding that reaches the next unit is promoted, not printed", () => {
    // 1023.6 KB rounds to 1024, which is not a kilobyte count anyone writes.
    expect(formatBytes(1024 * 1023.6)).toBe("1.0 MB");
    // Same carry one unit up, where the decimal form is what overflows.
    expect(formatBytes(1024 * 1024 * 1023.97)).toBe("1.0 GB");
  });

  test("a negative or non-finite count is 0 B rather than a broken sentence", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(-5_000_000)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  test.each([
    [0, "0:00"],
    [1, "0:00"],
    [499, "0:00"],
    // Rounds to the nearest second, not down.
    [500, "0:01"],
    [1000, "0:01"],
    [59_000, "0:59"],
    [60_000, "1:00"],
    [146_000, "2:26"],
    [249_000, "4:09"],
    // Under an hour there is no hours field, however many minutes there are.
    [3_540_000, "59:00"],
    // The bug this replaces: `call-audit/client.tsx` said "64:09" here.
    [3_849_000, "1:04:09"],
    [3_600_000, "1:00:00"],
    // Minutes are padded only once an hours field exists.
    [3_720_000, "1:02:00"],
    [36_000_000, "10:00:00"],
  ])("formats %dms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  test("a negative or non-finite duration is 0:00", () => {
    expect(formatDuration(-1)).toBe("0:00");
    expect(formatDuration(-90_000)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("countWords", () => {
  test.each([
    ["", 0],
    ["   ", 0],
    ["\n\t ", 0],
    ["hello", 1],
    ["hello there", 2],
    ["  hello   there\nfriend ", 3],
    // A transcript stitched with blank lines counts the same as a joined one.
    ["one two\n\nthree four", 4],
    // A non-breaking space, which a pasted transcript carries.
    ["one\u00a0two", 2],
  ])("counts %j as %d", (text, expected) => {
    expect(countWords(text)).toBe(expected);
  });

  test("the empty case is 0, which a bare split gets wrong", () => {
    // `"".split(/\s+/)` is `[""]` — length 1. That is the whole reason the
    // trim-and-test is here rather than at each call site.
    expect("".split(/\s+/)).toHaveLength(1);
    expect(countWords("")).toBe(0);
  });
});

describe("plural", () => {
  test.each([
    [1, "risk"],
    [0, "risks"],
    [2, "risks"],
    [17, "risks"],
    // Not English, but not a crash either: only exactly 1 is singular.
    [-1, "risks"],
    [1.5, "risks"],
  ])("pluralizes for %d as %s", (n, expected) => {
    expect(plural(n, "risk")).toBe(expected);
  });

  test("an irregular plural is passed in rather than derived", () => {
    expect(plural(1, "entry", "entries")).toBe("entry");
    expect(plural(3, "entry", "entries")).toBe("entries");
    expect(plural(0, "person", "people")).toBe("people");
  });

  test("it returns the word alone, so the caller formats the count", () => {
    const risks = 3;
    expect(`Found ${risks} ${plural(risks, "risk")}.`).toBe("Found 3 risks.");
  });
});

describe("the shapes the template copies produced", () => {
  test("one run reports one duration on both sides of the wire", () => {
    // The live bug: `call-audit/workflows/media.ts` said "1:04:09" and
    // `call-audit/client.tsx` said "64:09" for the same 3,849,000ms run.
    const ms = 3_849_000;
    expect(formatDuration(ms)).toBe("1:04:09");
    expect(formatDuration(ms)).toBe(formatDuration(ms));
  });
});
