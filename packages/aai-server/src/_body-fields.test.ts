// Copyright 2026 the AAI authors. MIT license.

import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import {
  isOneOf,
  optionalString,
  requiredInt,
  requiredSize,
  requiredString,
} from "./_body-fields.ts";

/** The status and message a reader threw, or a failure if it returned. */
function refusal(read: () => unknown): { status: number; message: string } {
  try {
    read();
  } catch (err) {
    if (err instanceof HTTPException) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error("expected the reader to throw");
}

describe("requiredString", () => {
  test("returns a non-empty string", () => {
    expect(requiredString({ path: "a.ts" }, "path")).toBe("a.ts");
  });

  test.each([
    ["absent", {}],
    ["empty", { path: "" }],
    ["a number", { path: 3 }],
  ])("answers 400 naming the key when %s", (_label, body) => {
    expect(refusal(() => requiredString(body, "path"))).toEqual({
      status: 400,
      message: "path is required",
    });
  });
});

describe("requiredInt", () => {
  test.each([0, -4, 12])("accepts the integer %d", (value) => {
    expect(requiredInt({ n: value }, "n")).toBe(value);
  });

  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", undefined])(
    "answers 400 for %s",
    (value) => {
      expect(refusal(() => requiredInt({ n: value }, "n"))).toEqual({
        status: 400,
        message: "n must be an integer",
      });
    },
  );
});

describe("requiredSize", () => {
  test("accepts zero and positive integers", () => {
    expect(requiredSize({ size: 0 }, "size")).toBe(0);
    expect(requiredSize({ size: 1024 }, "size")).toBe(1024);
  });

  test.each([-1, 2.5, "8"])("answers 400 naming the floor for %s", (value) => {
    expect(refusal(() => requiredSize({ size: value }, "size"))).toEqual({
      status: 400,
      message: "size must be a non-negative integer",
    });
  });
});

describe("optionalString", () => {
  test("absent reads as undefined, present as the string", () => {
    expect(optionalString({}, "cursor")).toBeUndefined();
    expect(optionalString({ cursor: "" }, "cursor")).toBe("");
  });

  test("present and not a string is a 400", () => {
    expect(refusal(() => optionalString({ cursor: null }, "cursor"))).toEqual({
      status: 400,
      message: "cursor must be a string",
    });
  });
});

describe("isOneOf", () => {
  const METHODS = ["read", "write"] as const;

  test("narrows a member and rejects everything else", () => {
    expect(isOneOf(METHODS, "read")).toBe(true);
    expect(isOneOf(METHODS, "delete")).toBe(false);
    expect(isOneOf(METHODS, 1)).toBe(false);
    expect(isOneOf(METHODS, undefined)).toBe(false);
  });
});
