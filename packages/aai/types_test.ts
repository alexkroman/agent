import { describe, expect, test } from "vitest";
import { DEFAULT_GREETING, DEFAULT_INSTRUCTIONS } from "./types.ts";

describe("constants", () => {
  test("DEFAULT_INSTRUCTIONS is a non-empty string", () => {
    expect(typeof DEFAULT_INSTRUCTIONS).toBe("string");
    expect(DEFAULT_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  test("DEFAULT_GREETING is a non-empty string", () => {
    expect(typeof DEFAULT_GREETING).toBe("string");
    expect(DEFAULT_GREETING.length).toBeGreaterThan(0);
  });
});
