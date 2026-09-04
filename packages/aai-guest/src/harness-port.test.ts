// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest's port validation.
 *
 * These were unreachable while the logic sat inside `main()`: that function
 * installs crash guards, tees both process streams and binds a server, so the
 * only way to exercise it was to spawn a real harness. The failure it prevents
 * — `listen(NaN)` binding an ephemeral port, so the guest looks healthy on a
 * port nobody dials — is exactly the kind that a spawn-level test reports as a
 * network timeout.
 */

import { describe, expect, test } from "vitest";
import { DEFAULT_GUEST_PORT, resolveGuestPort } from "./harness-port.ts";

describe("resolveGuestPort", () => {
  test("defaults when the spawner names no port", () => {
    expect(resolveGuestPort(undefined)).toBe(DEFAULT_GUEST_PORT);
  });

  test("takes a valid port", () => {
    expect(resolveGuestPort("3000")).toBe(3000);
  });

  test("takes 0, which the subprocess backend uses for 'any free port'", () => {
    expect(resolveGuestPort("0")).toBe(0);
  });

  test.each([
    ["not a number", "eight"],
    ["empty, which Number() reads as 0 but an operator means as unset", ""],
    ["fractional", "80.5"],
    ["negative", "-1"],
    ["above the range", "65536"],
  ])("refuses %s with a message naming the variable", (_label, raw) => {
    const answer = resolveGuestPort(raw);
    expect(typeof answer).toBe("string");
    expect(String(answer)).toContain("AAI_GUEST_PORT");
  });
});
