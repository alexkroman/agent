// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  SMS_ALLOWED_PHONES_ENV,
  SMS_TO_PHONE_ENV,
  TEXTBELT_KEY_ENV,
  TEXTBELT_LINKS_ENV,
  textbeltLinksFromEnv,
} from "./_owner-text-env.ts";

describe("the owner-text env contract", () => {
  test("names the variables the text_me builtin and stepTextOwner both read", () => {
    expect([
      TEXTBELT_KEY_ENV,
      SMS_TO_PHONE_ENV,
      SMS_ALLOWED_PHONES_ENV,
      TEXTBELT_LINKS_ENV,
    ]).toEqual(["TEXTBELT_KEY", "SMS_TO_PHONE", "SMS_ALLOWED_PHONES", "TEXTBELT_LINKS"]);
  });

  test("TEXTBELT_LINKS is strip in any case and trimmed, keep otherwise", () => {
    expect(textbeltLinksFromEnv("strip")).toBe("strip");
    expect(textbeltLinksFromEnv("  STRIP \n")).toBe("strip");
    expect(textbeltLinksFromEnv("keep")).toBe("keep");
    expect(textbeltLinksFromEnv("stripped")).toBe("keep");
    expect(textbeltLinksFromEnv("")).toBe("keep");
    expect(textbeltLinksFromEnv(undefined)).toBe("keep");
  });
});
