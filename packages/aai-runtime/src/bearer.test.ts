// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { isBlankSecret, parseBearer } from "./bearer.ts";

/**
 * The scheme match, the credential's case, and the extra-space case.
 *
 * A pre-fix FAILING observation is available for two of these and is the reason
 * the module exists: against `header.startsWith("Bearer ")` both
 * `parseBearer("bearer abc123")` and `parseBearer("Bearer  abc123")` returned a
 * value no comparison could match. `aai-server/_bearer.test.ts` had ASSERTED the
 * first of those as correct, which is what let the same line be copied twice
 * more.
 */
describe("parseBearer", () => {
  test.each(["Bearer", "bearer", "BEARER", "BeArEr"])(
    "matches the %s scheme case-insensitively, per RFC 7235 §2.1",
    (scheme) => {
      expect(parseBearer(`${scheme} abc123`)).toBe("abc123");
    },
  );

  test("leaves the credential's own case alone — token68 is case-sensitive", () => {
    // The whole header must never be lower-cased: that destroys the credential
    // it is wrapped around.
    expect(parseBearer("bearer AbC123-_~+/=")).toBe("AbC123-_~+/=");
  });

  test("trims the extra spaces `auth-scheme 1*SP token68` permits", () => {
    // `token68` cannot contain a space, so `Bearer  key` is one spelling of one
    // token — where a fixed seven-character slice yielded `" key"`, a different
    // token that failed every comparison.
    expect(parseBearer("Bearer  abc123")).toBe("abc123");
    expect(parseBearer("bearer\tabc123")).toBe("");
  });

  test("answers the empty string for anything that is not a Bearer credential", () => {
    expect(parseBearer(undefined)).toBe("");
    expect(parseBearer(null)).toBe("");
    expect(parseBearer("")).toBe("");
    expect(parseBearer("Basic abc123")).toBe("");
    // No delimiting space: `Bearerabc123` is one token, not a scheme.
    expect(parseBearer("Bearerabc123")).toBe("");
    // A scheme with no credential is not a credential.
    expect(parseBearer("Bearer ")).toBe("");
    expect(parseBearer("Bearer    ")).toBe("");
  });
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
