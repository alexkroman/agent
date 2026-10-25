// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { parseBearer } from "./parse-bearer.ts";

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
