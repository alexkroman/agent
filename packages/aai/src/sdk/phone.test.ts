// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { normalizePhone } from "./phone.ts";

describe("normalizePhone", () => {
  test("an E.164 number, formatted any way, comes back bare", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone(" +1 (512) 555-0123 ")).toBe("+15125550123");
    expect(normalizePhone("+1.512.555.0123", { defaultCountry: "US" })).toBe("+15125550123");
  });

  test("without a default country, a number missing its + is refused, not guessed", () => {
    expect(normalizePhone("(512) 555-0123")).toBeUndefined();
    expect(normalizePhone("15125550123")).toBeUndefined();
  });

  test("with US or CA, ten digits or 1 + ten digits read as +1", () => {
    expect(normalizePhone("(512) 555-0123", { defaultCountry: "US" })).toBe("+15125550123");
    expect(normalizePhone("1 512 555 0123", { defaultCountry: "US" })).toBe("+15125550123");
    expect(normalizePhone("604-555-0199", { defaultCountry: "CA" })).toBe("+16045550199");
  });

  test("what is not a North American number stays refused under a default country", () => {
    for (const raw of [
      "555-0123",
      "012 555 0123",
      "512 055 0123",
      "2 512 555 0123",
      "call me",
      "",
    ]) {
      expect.soft(normalizePhone(raw, { defaultCountry: "US" }), raw).toBeUndefined();
    }
    expect(normalizePhone("+0 512 555 0123", { defaultCountry: "US" })).toBeUndefined();
  });
});
