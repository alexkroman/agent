// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { timingSafeEqual } from "./_timing-safe-equal.ts";

describe("timingSafeEqual", () => {
  test("equal strings match, and the empty string matches itself", () => {
    expect(timingSafeEqual("v1,abc=", "v1,abc=")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  test("a differing character anywhere is a mismatch", () => {
    expect(timingSafeEqual("abcdef", "Xbcdef")).toBe(false);
    expect(timingSafeEqual("abcdef", "abcdeX")).toBe(false);
  });

  test("a prefix is a mismatch in either direction, not a match of the shorter", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
  });
});
