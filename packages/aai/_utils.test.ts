// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { errorMessage, filterEnv } from "./_utils.ts";

describe("errorMessage", () => {
  test("extracts message from Error instance", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("converts string to string", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  test("converts number to string", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("filterEnv", () => {
  test("removes undefined values", () => {
    const result = filterEnv({ A: "1", B: undefined, C: "3" });
    expect(result).toEqual({ A: "1", C: "3" });
  });

  test("returns empty object for all-undefined input", () => {
    expect(filterEnv({ X: undefined, Y: undefined })).toEqual({});
  });

  test("returns all entries when none are undefined", () => {
    expect(filterEnv({ A: "a", B: "b" })).toEqual({ A: "a", B: "b" });
  });

  test("handles empty record", () => {
    expect(filterEnv({})).toEqual({});
  });
});
