// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { parseBearer } from "./_bearer.ts";

describe("parseBearer", () => {
  test("extracts the token from a Bearer header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
  });

  test("returns empty for a missing header", () => {
    expect(parseBearer(null)).toBe("");
    expect(parseBearer(undefined)).toBe("");
  });

  test("returns empty for non-Bearer schemes and malformed values", () => {
    expect(parseBearer("Basic abc123")).toBe("");
    expect(parseBearer("bearer abc123")).toBe("");
    expect(parseBearer("Bearer")).toBe("");
  });
});
