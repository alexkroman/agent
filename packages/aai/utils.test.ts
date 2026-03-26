// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { errorDetail, errorMessage, filterEnv } from "./utils.ts";

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

describe("errorDetail", () => {
  test("returns stack trace from Error instance", () => {
    const err = new Error("test error");
    const detail = errorDetail(err);
    expect(detail).toContain("test error");
    expect(detail).toContain("Error");
  });

  test("returns message when Error has no stack", () => {
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined });
    expect(errorDetail(err)).toBe("no stack");
  });

  test("converts non-Error to string", () => {
    expect(errorDetail("plain string")).toBe("plain string");
    expect(errorDetail(42)).toBe("42");
    expect(errorDetail(null)).toBe("null");
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
