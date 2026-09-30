// Copyright 2026 the AAI authors. MIT license.
/**
 * `phoneE164`: a number however it is typed, in the form the session's `phone`
 * must carry — and `undefined`, never a guess, for one that cannot be. Fictional
 * numbers only (555-01xx is reserved for fiction).
 */

import { describe, expect, test } from "vitest";
import { phoneE164 } from "./phone.ts";

describe("phoneE164", () => {
  test("a number with its country code, however it is punctuated", () => {
    expect(phoneE164("+1 555 555 0123")).toBe("+15555550123");
    expect(phoneE164("+44 (20) 7946-0958")).toBe("+442079460958");
    expect(phoneE164("0044 20 7946 0958")).toBe("+442079460958");
  });

  test("without a country code and none assumed, nothing — the server would drop it too", () => {
    expect(phoneE164("(555) 555-0123")).toBeUndefined();
    expect(phoneE164("")).toBeUndefined();
    expect(phoneE164("call me")).toBeUndefined();
    expect(phoneE164("+1234567890123456")).toBeUndefined();
  });

  test('countryCode "1": ten digits take +1, eleven starting with 1 already carry it', () => {
    const us = { countryCode: "1" };
    expect(phoneE164("(555) 555-0123", us)).toBe("+15555550123");
    expect(phoneE164("555.555.0123", us)).toBe("+15555550123");
    expect(phoneE164("1 555 555 0123", us)).toBe("+15555550123");
    expect(phoneE164("+44 20 7946 0958", us)).toBe("+442079460958");
    expect(phoneE164("5550123", us)).toBeUndefined();
    expect(phoneE164("020 7946 0958", us)).toBeUndefined();
  });

  test("any other code drops one trunk 0 and prepends itself", () => {
    expect(phoneE164("020 7946 0958", { countryCode: "+44" })).toBe("+442079460958");
    expect(phoneE164("0123", { countryCode: "44" })).toBeUndefined();
    expect(phoneE164("020 7946 0958", { countryCode: "4444" })).toBeUndefined();
  });
});
