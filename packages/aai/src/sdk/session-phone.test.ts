// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { createToolContext } from "./_testing-context.ts";
import { normalizeE164, sessionClientPhone, setSessionPhone } from "./session-phone.ts";

afterEach(() => vi.useRealTimers());

describe("normalizeE164", () => {
  test("strips spaces, dashes, dots and parentheses around a + number", () => {
    expect(normalizeE164("+1 (503) 555-0123")).toBe("+15035550123");
    expect(normalizeE164("+44.20.7946.0958")).toBe("+442079460958");
    expect(normalizeE164("+15035550123")).toBe("+15035550123");
  });

  test("a number without its + is refused, not assumed to be North American", () => {
    expect(normalizeE164("5035550123")).toBeUndefined();
    expect(normalizeE164("(503) 555-0123")).toBeUndefined();
  });

  test("8 to 15 digits, and nothing but digits after the +", () => {
    expect(normalizeE164("+1234567")).toBeUndefined();
    expect(normalizeE164("+12345678")).toBe("+12345678");
    expect(normalizeE164("+123456789012345")).toBe("+123456789012345");
    expect(normalizeE164("+1234567890123456")).toBeUndefined();
    for (const bad of ["", "+", "+0035550123", "+1503555012x", "++15035550123", "+1503/5550123"]) {
      expect.soft(normalizeE164(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  test("an over-long value is refused before it is scanned", () => {
    expect(normalizeE164(`+1503555012${" ".repeat(60)}3`)).toBeUndefined();
  });
});

describe("sessionClientPhone", () => {
  test("answers the number recorded for the session, and undefined for any other", () => {
    setSessionPhone("phone-a", "+15035550123");
    expect(sessionClientPhone({ sessionId: "phone-a" })).toBe("+15035550123");
    expect(sessionClientPhone({ sessionId: "phone-unknown" })).toBeUndefined();
  });

  test("a later record for the same session replaces the earlier one", () => {
    setSessionPhone("phone-b", "+15035550100");
    setSessionPhone("phone-b", "+15035550199");
    expect(sessionClientPhone({ sessionId: "phone-b" })).toBe("+15035550199");
  });

  test("the store is shared through globalThis, so a second copy of the module reads it", () => {
    setSessionPhone("phone-c", "+15035550123");
    const store = (globalThis as Record<symbol, Map<string, { phone: string }> | undefined>)[
      Symbol.for("@alexkroman1/aai.sessionPhones")
    ];
    expect(store?.get("phone-c")?.phone).toBe("+15035550123");
  });

  test("an entry expires after a day", () => {
    vi.useFakeTimers();
    setSessionPhone("phone-d", "+15035550123");
    vi.advanceTimersByTime(86_400_001);
    expect(sessionClientPhone({ sessionId: "phone-d" })).toBeUndefined();
  });

  test("createToolContext({ clientPhone }) seeds it for the context's session, and only that one", () => {
    expect(sessionClientPhone(createToolContext({ clientPhone: "+15035550123" }))).toBe(
      "+15035550123",
    );
    expect(sessionClientPhone(createToolContext())).toBeUndefined();
  });
});
