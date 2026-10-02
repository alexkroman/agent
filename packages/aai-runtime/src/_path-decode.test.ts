// Copyright 2026 the AAI authors. MIT license.
/**
 * `decodePathSegment` answers `undefined`, never throws, for every
 * undecodable segment — and for a NUL, which decodes cleanly but has no legal
 * reading in any store.
 */

import { describe, expect, test } from "vitest";
import { decodePathSegment } from "./_path-decode.ts";

describe("decodePathSegment", () => {
  test.each([
    ["plain", "plain"],
    ["wrun_abc", "wrun_abc"],
    ["a%20b", "a b"],
    ["caf%C3%A9", "café"],
    ["%01", "\u0001"],
    ["", ""],
  ])("decodes %j", (raw, expected) => {
    expect(decodePathSegment(raw)).toBe(expected);
  });

  test.each(["%", "%A", "%zz", "%C0%80", "abc%"])("answers undefined for malformed %j", (raw) => {
    expect(decodePathSegment(raw)).toBeUndefined();
  });

  test.each(["%00", "tt%00sess", "a\u0000b"])("answers undefined for a NUL in %j", (raw) => {
    expect(decodePathSegment(raw)).toBeUndefined();
  });
});
