// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { linkConfirmationCode } from "./cli-link.ts";

describe("linkConfirmationCode", () => {
  // These fixtures used to live twice — once in aai-cli's login.test.ts and
  // once in aai-studio-client's cli-link.test.ts, each with a comment naming
  // the other. That arrangement can only ever detect a drift someone
  // remembered to introduce in both places; there is one derivation now, and
  // this is its spec.
  test("is the first 8 characters, uppercased and hyphenated", () => {
    expect(linkConfirmationCode("abcDEF12_-345678901234567890123456789012345")).toBe("ABCD-EF12");
    expect(linkConfirmationCode("zzzzyyyy-rest-ignored-0000000000000000000")).toBe("ZZZZ-YYYY");
  });

  test("a code shorter than 8 characters yields what there is, not padding", () => {
    // A short code cannot happen (`randomBytes(32)` base64url'd), but the
    // slice must not invent characters to compare against either.
    expect(linkConfirmationCode("abc")).toBe("ABC-");
    expect(linkConfirmationCode("")).toBe("-");
  });
});
