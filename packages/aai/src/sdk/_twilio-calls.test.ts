// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { normalizeCallStatus, twilioAdvice } from "./_twilio-calls.ts";

describe("statuses and advice", () => {
  test("Twilio's statuses normalize, initiated reads as queued, anything else is unknown", () => {
    expect(normalizeCallStatus("in-progress")).toBe("in-progress");
    expect(normalizeCallStatus("initiated")).toBe("queued");
    expect(normalizeCallStatus("teleported")).toBeUndefined();
    expect(normalizeCallStatus(7)).toBeUndefined();
  });

  test("an unknown code keeps Twilio's message and names the code or the status", () => {
    expect(twilioAdvice(13_224, "Invalid timeout", 400)).toBe(
      "Twilio couldn't place the call: Invalid timeout (Twilio error 13224)",
    );
    expect(twilioAdvice(undefined, "HTTP 502", 502)).toMatch(/\(Twilio HTTP 502\)$/);
  });
});
