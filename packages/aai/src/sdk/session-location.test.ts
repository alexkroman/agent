// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { createToolContext } from "./_testing-context.ts";
import {
  normalizeClientLocation,
  sessionClientLocation,
  setSessionLocation,
} from "./session-location.ts";

afterEach(() => vi.useRealTimers());

describe("normalizeClientLocation", () => {
  test("control characters become spaces and whitespace collapses", () => {
    expect(normalizeClientLocation("  123 Example St,\n\tPortland ")).toBe(
      "123 Example St, Portland",
    );
  });

  test("absent, blank and over-long are all none — never truncated into another place", () => {
    expect(normalizeClientLocation(null)).toBeUndefined();
    expect(normalizeClientLocation(undefined)).toBeUndefined();
    expect(normalizeClientLocation(" \u0000 ")).toBeUndefined();
    expect(normalizeClientLocation("x".repeat(201))).toBeUndefined();
    expect(normalizeClientLocation("x".repeat(200))).toHaveLength(200);
  });
});

describe("sessionClientLocation", () => {
  test("answers the location recorded for the session, and the LATER writer wins", () => {
    setSessionLocation("loc-sdk-a", "1 Device Rd, Springfield");
    expect(sessionClientLocation({ sessionId: "loc-sdk-a" })).toBe("1 Device Rd, Springfield");
    // What `sessionContext`'s `location` does after the socket's `?location=`.
    setSessionLocation("loc-sdk-a", "2 App Ave, Springfield");
    expect(sessionClientLocation({ sessionId: "loc-sdk-a" })).toBe("2 App Ave, Springfield");
    expect(sessionClientLocation({ sessionId: "loc-sdk-never" })).toBeUndefined();
  });

  test("the store is shared through globalThis, so the agent bundle's copy reads it", () => {
    setSessionLocation("loc-sdk-b", "3 Shared St");
    const store = (globalThis as Record<symbol, Map<string, { location: string }> | undefined>)[
      Symbol.for("@alexkroman1/aai.sessionLocations")
    ];
    expect(store?.get("loc-sdk-b")?.location).toBe("3 Shared St");
  });

  test("an entry expires after a day", () => {
    vi.useFakeTimers();
    setSessionLocation("loc-sdk-c", "4 Old Rd");
    vi.advanceTimersByTime(86_400_001);
    expect(sessionClientLocation({ sessionId: "loc-sdk-c" })).toBeUndefined();
  });

  test("createToolContext({ clientLocation }) seeds it for the context's session", () => {
    expect(sessionClientLocation(createToolContext({ clientLocation: "5 Test Ln" }))).toBe(
      "5 Test Ln",
    );
    expect(sessionClientLocation(createToolContext())).toBeUndefined();
  });
});
