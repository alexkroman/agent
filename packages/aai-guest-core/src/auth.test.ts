// Copyright 2026 the AAI authors. MIT license.
/**
 * Bearer-token derivation for the guest's authenticated surfaces.
 *
 * Split out of `aai-guest/src/harness.test.ts` when this module moved into
 * `aai-guest-core`: coverage attributes a file to whoever LOADS it, so a
 * module whose only tests live in a dependent package reads as uncovered in
 * its own — which seeds a floor that cannot fail. A test follows its subject.
 */

import { describe, expect, test } from "vitest";
import { bearerToken } from "./auth.ts";

describe("bearerToken", () => {
  test("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
  });

  // The FAILING observation. Against `header?.startsWith("Bearer ")` both of
  // these were `null`, so a client sending the spec-legal
  // `authorization: bearer <token>` was refused by the `/ws` control channel and
  // by the studio chat surface alike — a 401 whose sentence named a missing or
  // invalid token rather than a capitalisation. The old spec here asserted only
  // the one capitalisation this repo happens to send, so it agreed with the bug
  // without pinning it; `aai-server/_bearer.test.ts` had gone one step further
  // and asserted the bug as correct.
  test.each(["bearer", "BEARER", "BeArEr"])(
    "accepts the %s scheme too, per RFC 7235 §2.1",
    (scheme) => {
      expect(bearerToken(`${scheme} abc123`)).toBe("abc123");
    },
  );

  test("accepts the extra spaces `auth-scheme 1*SP token68` permits", () => {
    expect(bearerToken("Bearer  abc123")).toBe("abc123");
  });

  test("rejects missing or non-Bearer headers", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    // A scheme with no credential is not a credential — `null`, not `""`, so
    // `verifyBearer`'s length check is not the only thing standing between an
    // empty parse and a comparison.
    expect(bearerToken("Bearer ")).toBeNull();
  });
});
