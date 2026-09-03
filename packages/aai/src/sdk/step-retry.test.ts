// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the retry split and the `Retry-After` reader.
 *
 * The parsing is the part worth pinning: both header spellings are legal, one
 * of them (`30`) is also parsable as a date by some engines, and every
 * unusable value has to answer `undefined` — which means "the DevKit's own
 * backoff" rather than a deadline that retries instantly or never.
 */

import { describe, expect, test } from "vitest";
import { isTransientStatus, retryAfter } from "./step-retry.ts";

describe("isTransientStatus", () => {
  test.each([408, 429, 500, 502, 503, 504])("retries %i", (status) => {
    expect(isTransientStatus(status)).toBe(true);
  });

  test.each([200, 400, 401, 403, 404, 409, 422])("gives up on %i", (status) => {
    expect(isTransientStatus(status)).toBe(false);
  });
});

describe("retryAfter", () => {
  test("reads delta-seconds", () => {
    const at = retryAfter(new Headers({ "Retry-After": "30" }));
    const wait = (at?.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);
  });

  test("reads an HTTP date", () => {
    const when = new Date(Date.now() + 120_000);
    const at = retryAfter(new Headers({ "Retry-After": when.toUTCString() }));
    // To the second: an HTTP date carries no milliseconds.
    expect(at?.getTime()).toBe(Math.floor(when.getTime() / 1000) * 1000);
  });

  test("accepts a Response as well as its headers", () => {
    const res = new Response(null, { status: 429, headers: { "Retry-After": "5" } });
    expect(retryAfter(res)).toBeInstanceOf(Date);
  });

  test("answers undefined for an absent header", () => {
    expect(retryAfter(new Headers())).toBeUndefined();
  });

  test("answers undefined for a value it cannot read", () => {
    expect(retryAfter(new Headers({ "Retry-After": "soon" }))).toBeUndefined();
  });

  test("answers undefined for a date already past", () => {
    // "Retry now" is the DevKit's own backoff, not a deadline in the past.
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfter(new Headers({ "Retry-After": past }))).toBeUndefined();
  });
});
