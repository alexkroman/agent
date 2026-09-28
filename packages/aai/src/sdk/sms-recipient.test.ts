// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { allowedSmsRecipient } from "./sms-recipient.ts";

const OWNER = "+15555550100";

describe("allowedSmsRecipient", () => {
  test("a claim the owner listed is used", () => {
    const env = { SMS_TO_PHONE: OWNER, SMS_ALLOWED_PHONES: "+15555550123, +442079460958" };
    expect(allowedSmsRecipient("+15555550123", env)).toBe("+15555550123");
    expect(allowedSmsRecipient("+44 20 7946 0958", env)).toBe("+442079460958");
    // The owner's own number is implicitly allowed.
    expect(allowedSmsRecipient(OWNER, { SMS_TO_PHONE: OWNER })).toBe(OWNER);
  });

  test("an unlisted claim falls back to SMS_TO_PHONE, never texted itself", () => {
    const env = { SMS_TO_PHONE: OWNER, SMS_ALLOWED_PHONES: "+15555550123" };
    expect(allowedSmsRecipient("+15555550199", env)).toBe(OWNER);
    expect(allowedSmsRecipient("not a number", env)).toBe(OWNER);
    expect(allowedSmsRecipient(undefined, env)).toBe(OWNER);
  });

  test("no SMS_TO_PHONE and no allowed claim is no recipient at all", () => {
    expect(allowedSmsRecipient("+15555550199", {})).toBeUndefined();
    expect(allowedSmsRecipient("+15555550199", { SMS_ALLOWED_PHONES: "+15555550123" })).toBe(
      undefined,
    );
    expect(allowedSmsRecipient(undefined, { SMS_TO_PHONE: "  " })).toBeUndefined();
  });

  test("an allowed claim is honored even without SMS_TO_PHONE", () => {
    expect(allowedSmsRecipient("+15555550123", { SMS_ALLOWED_PHONES: "+15555550123" })).toBe(
      "+15555550123",
    );
  });

  test("the claim and the lists are normalized the same way", () => {
    expect(allowedSmsRecipient("+1 (555) 555-0123", { SMS_TO_PHONE: "+15555550123" })).toBe(
      "+15555550123",
    );
    expect(
      allowedSmsRecipient("+15555550123", {
        SMS_TO_PHONE: OWNER,
        SMS_ALLOWED_PHONES: " +1 (555) 555-0123 ,",
      }),
    ).toBe("+15555550123");
    // A listed number with no `+` normalizes to nothing, so it matches nothing.
    expect(allowedSmsRecipient("+15555550123", { SMS_ALLOWED_PHONES: "5555550123" })).toBe(
      undefined,
    );
  });

  test("an SMS_TO_PHONE that is not E.164 is still the fallback, as configured", () => {
    // Textbelt takes a bare 10-digit US number, so the owner's own setting is
    // passed through; it just cannot be matched against a claim.
    expect(allowedSmsRecipient("+15555550123", { SMS_TO_PHONE: "5555550100" })).toBe("5555550100");
  });

  test("SMS_ALLOWED_PHONES=* allows any valid claim, and still no invalid one", () => {
    const env = { SMS_TO_PHONE: "+15555550100", SMS_ALLOWED_PHONES: " * " };
    expect(allowedSmsRecipient("+1 555 555 0177", env)).toBe("+15555550177");
    expect(allowedSmsRecipient("5555550177", env)).toBe("+15555550100"); // no +: not E.164
    expect(allowedSmsRecipient(undefined, env)).toBe("+15555550100");
    // Only the whole value: a `*` inside a list is not a wildcard.
    expect(allowedSmsRecipient("+15555550177", { SMS_ALLOWED_PHONES: "+15555550123,*" })).toBe(
      undefined,
    );
  });
});
