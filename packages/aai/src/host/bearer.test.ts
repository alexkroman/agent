// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { constantTimeEquals, isBlankSecret, parseBearer } from "./bearer.ts";

// `parseBearer`'s own spec is `sdk/parse-bearer.test.ts`; it is re-exported
// here beside the gate halves that read it, which is what this file pins.
test("re-exports the SDK's one bearer parser", () => {
  expect(parseBearer("Bearer abc")).toBe("abc");
});

/**
 * The predicate that closes the empty-secret bypass.
 *
 * The FAILING observation is on the caller, not here — `bearerMatches(undefined,
 * "")` answered `true`, so a request with no `Authorization` header at all
 * authenticated against a set-but-empty secret. This asserts the property that
 * makes the fix possible: `parseBearer` cannot PRODUCE a blank value that means
 * "a credential was presented", so no blank value may be treated as one.
 */
describe("isBlankSecret", () => {
  test.each(["", " ", "   ", "\t", "\n", " \t\n "])(
    "reports %j blank — nothing may authenticate against it",
    (secret) => {
      expect(isBlankSecret(secret)).toBe(true);
    },
  );

  test("an absent secret is blank, so one predicate covers both", () => {
    expect(isBlankSecret(undefined)).toBe(true);
    expect(isBlankSecret(null)).toBe(true);
  });

  test("every blank value is outside parseBearer's codomain", () => {
    // The whole argument in one assertion: a caller cannot present a blank
    // token, so an expected blank can only ever be matched by a caller who
    // presented NOTHING.
    for (const header of ["Bearer ", "Bearer    ", "bearer\t", "", "Basic x", undefined]) {
      expect(isBlankSecret(parseBearer(header)), String(header)).toBe(true);
    }
  });

  test("a real secret is not blank, however it is punctuated", () => {
    expect(isBlankSecret("s3cret")).toBe(false);
    expect(isBlankSecret("-")).toBe(false);
    expect(isBlankSecret("AbC123-_~+/=")).toBe(false);
  });

  test("a PADDED secret is deliberately not blank", () => {
    // `parseBearer` trims, so `" x "` is unpresentable too — but the callers act
    // on this answer by falling back to their DEFAULT posture, and for the
    // workflow API that default is OPEN. Widening past "no secret at all" would
    // let a typo open a surface instead of closing it.
    expect(isBlankSecret(" x ")).toBe(false);
  });
});

describe("constantTimeEquals", () => {
  test("equal strings match, and a length mismatch answers false rather than throwing", () => {
    expect(constantTimeEquals("s3cret", "s3cret")).toBe(true);
    expect(constantTimeEquals("s3cret", "s3creT")).toBe(false);
    expect(constantTimeEquals("s3cret", "s3cret-longer")).toBe(false);
    // Compared as UTF-8 bytes: one string length can be two byte lengths.
    expect(constantTimeEquals("é", "e")).toBe(false);
  });
});
