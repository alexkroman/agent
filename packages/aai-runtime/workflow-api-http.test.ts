// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { bearerMatches } from "./workflow-api-http.ts";

/**
 * The workflow API's gate, which had its own copy of the scheme match.
 *
 * The FAILING observation: against `header?.startsWith("Bearer ")` the first
 * case below was `false` — a spec-legal `authorization: bearer <token>` was
 * refused by every route on `/:slug/workflows/*` and by the session-events API,
 * with the reply naming an authorization failure rather than a capitalisation.
 * This module had no spec of its own, which is why the copy went unnoticed.
 */
describe("bearerMatches", () => {
  test("accepts a lower-cased scheme, per RFC 7235 §2.1", () => {
    expect(bearerMatches("bearer s3cret", "s3cret")).toBe(true);
  });

  test("accepts the capitalisation this repo happens to send", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
  });

  test("accepts the extra spaces the grammar permits", () => {
    expect(bearerMatches("Bearer  s3cret", "s3cret")).toBe(true);
  });

  test("still refuses a wrong token, another scheme, and no header at all", () => {
    expect(bearerMatches("Bearer wrong", "s3cret")).toBe(false);
    expect(bearerMatches("Basic s3cret", "s3cret")).toBe(false);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
  });

  /**
   * The empty-secret bypass, which failed OPEN.
   *
   * The FAILING observation, measured before the guard: all three cases below
   * answered `true`. `timingSafeEqual` on two empty buffers MATCHES, and both
   * callers guarded `token === undefined` while neither guarded `token === ""` —
   * so `AAI_WORKFLOW_API_TOKEN=` or `AAI_SESSION_EVENTS_TOKEN=`, set but empty,
   * authenticated every request including one carrying no `Authorization` header
   * at all. A blank secret is not a short secret: `parseBearer` maps "no header",
   * "not a Bearer credential" and "Bearer with an empty token" all onto `""`, so
   * an expected `""` is a value no caller can present and every caller who
   * presents nothing accidentally equals.
   */
  describe("a BLANK expected secret authenticates nothing", () => {
    test.each([undefined, "Basic whatever", "nonsense", "Bearer ", "Bearer anything"])(
      "refuses %j against an empty secret",
      (header) => {
        expect(bearerMatches(header, "")).toBe(false);
      },
    );

    test("a whitespace-only secret is the same case — parseBearer TRIMS", () => {
      // Its trim means `"   "` is likewise unpresentable, so without the guard
      // this arm 401s forever rather than opening — a quieter failure, not a
      // different one.
      expect(bearerMatches("Bearer    ", "   ")).toBe(false);
      expect(bearerMatches(undefined, "\t")).toBe(false);
    });

    test("a one-character secret still works, so the guard is not a length floor", () => {
      expect(bearerMatches("Bearer x", "x")).toBe(true);
    });
  });
});
