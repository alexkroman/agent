// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { CALL_OVER_STATUSES, isCallOver } from "./call-status.ts";

describe("isCallOver", () => {
  test.each([...CALL_OVER_STATUSES])(
    "%s is over — every member of CALL_OVER_STATUSES is",
    (status) => {
      expect(isCallOver(status)).toBe(true);
    },
  );

  test.each(["queued", "ringing", "in-progress"])("%s is a live call", (status) => {
    expect(isCallOver(status)).toBe(false);
  });

  test("a status the carrier invents tomorrow is not over — the set is the whole claim", () => {
    expect(isCallOver("on-hold")).toBe(false);
    expect(isCallOver("")).toBe(false);
  });

  test("the terminal set is the five Twilio ends a placed call can reach", () => {
    expect([...CALL_OVER_STATUSES].sort()).toEqual(
      ["busy", "canceled", "completed", "failed", "no-answer"].sort(),
    );
  });
});
