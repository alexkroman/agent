// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { spokenErrorReason } from "./spoken-error-reason.ts";

describe("spokenErrorReason", () => {
  test("keeps the first sentence only", () => {
    expect(spokenErrorReason(new Error("The mailbox is full. Try again tomorrow."))).toBe(
      "The mailbox is full.",
    );
  });

  test("does not end a sentence inside a host name or a version", () => {
    expect(spokenErrorReason(new Error("api.example.com v1.2 refused the call"))).toBe(
      "api.example.com v1.2 refused the call",
    );
  });

  test("drops URLs and the credentials they carry", () => {
    const why = spokenErrorReason(
      new Error("Request to https://api.example.com/v1?key=abc123&x=1 failed with 403. Later."),
    );
    expect(why).toBe("Request to failed with 403.");
    expect(why).not.toContain("abc123");
  });

  test.each([
    ["invalid api_key=sk_live_verysecretvalue1", "invalid api_key=[redacted]"],
    ["bad token=eyJhbGciOi.payload.sig here", "bad token=[redacted] here"],
    ["password=hunter2 rejected", "password=[redacted] rejected"],
    ["Authorization failed: Bearer abcdefgh12345678", "Authorization failed: Bearer [redacted]"],
    ["key sk-proj-abcdefghijklmnop was revoked", "key [redacted] was revoked"],
  ])("redacts %j", (message, expected) => {
    expect(spokenErrorReason(new Error(message))).toBe(expected);
  });

  test("does not redact a word that merely ends in key", () => {
    expect(spokenErrorReason("monkey=banana is fine")).toBe("monkey=banana is fine");
  });

  test("caps the length on a word boundary", () => {
    const why = spokenErrorReason(new Error(`${"word ".repeat(100)}end`), { max: 40 });
    expect(why.length).toBeLessThanOrEqual(40);
    expect(why.endsWith("word")).toBe(true);
  });

  test("defaults the cap to 160 characters", () => {
    expect(spokenErrorReason("x".repeat(500))).toHaveLength(160);
  });

  test("accepts anything thrown", () => {
    expect(spokenErrorReason("plain string")).toBe("plain string");
    expect(spokenErrorReason({ message: "object with a message" })).toBe("object with a message");
    expect(spokenErrorReason(42)).toBe("42");
  });

  test("answers a fallback when nothing sayable is left", () => {
    expect(spokenErrorReason({ message: "" })).toBe("something went wrong");
    expect(spokenErrorReason(new Error("https://example.com/only-a-url"))).toBe(
      "something went wrong",
    );
    expect(spokenErrorReason(undefined)).toBe("undefined");
  });
});
