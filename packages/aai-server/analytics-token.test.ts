// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { mintAnalyticsToken, verifyAnalyticsToken } from "./analytics-token.ts";

const SECRET = "platform-secret";

describe("analytics ingest tokens", () => {
  test("a minted token verifies for its own slug", () => {
    const token = mintAnalyticsToken(SECRET, "my-agent");
    expect(verifyAnalyticsToken(SECRET, "my-agent", token)).toBe(true);
  });

  test("authorizes exactly ONE slug", () => {
    // The whole point: a token lifted from one tenant's guest cannot write
    // rows attributed to another agent.
    const token = mintAnalyticsToken(SECRET, "my-agent");
    expect(verifyAnalyticsToken(SECRET, "other-agent", token)).toBe(false);
    expect(verifyAnalyticsToken(SECRET, "my-agent-preview", token)).toBe(false);
  });

  test("a different platform secret invalidates every token", () => {
    const token = mintAnalyticsToken(SECRET, "my-agent");
    expect(verifyAnalyticsToken("rotated", "my-agent", token)).toBe(false);
  });

  test("is deterministic, which is what makes verification stateless", () => {
    // Every replica must accept a token minted by any other one, with no
    // lookup on the highest-write path the platform has.
    expect(mintAnalyticsToken(SECRET, "a")).toBe(mintAnalyticsToken(SECRET, "a"));
  });

  test("rejects a wrong-length token without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the cheap check runs first.
    expect(() => verifyAnalyticsToken(SECRET, "a", "")).not.toThrow();
    expect(verifyAnalyticsToken(SECRET, "a", "")).toBe(false);
    expect(verifyAnalyticsToken(SECRET, "a", "short")).toBe(false);
  });

  test("a multibyte token of the right CHARACTER length is a rejection, not a throw", () => {
    // The guard used String.length (UTF-16 code units) while timingSafeEqual
    // compares encoded bytes. A 64-character multibyte token cleared the guard
    // and threw `RangeError: Input buffers must have the same byte length` —
    // a 500 from an unauthenticated public route, where 401 is the answer.
    const expected = mintAnalyticsToken(SECRET, "a");
    // Repeated to the same UTF-16 LENGTH, which is what the old guard read —
    // the emoji is a surrogate pair, so it takes half as many of them.
    for (const filler of ["é", "√", "🙂"]) {
      const sameChars = filler.repeat(expected.length / filler.length);
      expect(sameChars.length).toBe(expected.length);
      expect(Buffer.byteLength(sameChars)).not.toBe(Buffer.byteLength(expected));
      expect(() => verifyAnalyticsToken(SECRET, "a", sameChars)).not.toThrow();
      expect(verifyAnalyticsToken(SECRET, "a", sameChars)).toBe(false);
    }
  });

  test("does not leak the secret into the token", () => {
    expect(mintAnalyticsToken(SECRET, "a")).not.toContain(SECRET);
  });
});
