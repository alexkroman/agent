// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { isRecord } from "./is-record.ts";

describe("isRecord", () => {
  test.each([{}, { a: 1 }, Object.create(null), new Date(0), new Map()])(
    "accepts an object: %o",
    (value) => {
      expect(isRecord(value)).toBe(true);
    },
  );

  test.each([null, undefined, [], [1], "s", 0, true, () => undefined])(
    "refuses a non-record: %o",
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
