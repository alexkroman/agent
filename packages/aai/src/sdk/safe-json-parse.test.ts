// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { safeJsonParse } from "./safe-json-parse.ts";

describe("safeJsonParse", () => {
  test.each([
    ['{"a":1}', { a: 1 }],
    ["[1,2]", [1, 2]],
    ['"text"', "text"],
    ["null", null],
    ["0", 0],
    ["false", false],
  ])("parses %s", (text, value) => {
    expect(safeJsonParse(text)).toEqual(value);
  });

  test.each(["", "{", "undefined", "{'a':1}", "[1,]"])(
    "answers undefined for malformed %j rather than throwing",
    (text) => {
      expect(safeJsonParse(text)).toBeUndefined();
    },
  );
});
