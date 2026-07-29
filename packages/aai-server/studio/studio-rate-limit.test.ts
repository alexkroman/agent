// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createRateLimiter } from "./studio-rate-limit.ts";

describe("createRateLimiter", () => {
  test("allows up to the limit within a window, then refuses", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect(limiter.check("scope", t0)).toEqual({ ok: true });
    expect(limiter.check("scope", t0 + 1)).toEqual({ ok: true });
    expect(limiter.check("scope", t0 + 2)).toEqual({ ok: true });
    const verdict = limiter.check("scope", t0 + 3);
    expect(verdict.ok).toBe(false);
  });

  test("reports how long until the window resets", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    limiter.check("scope", t0);
    const verdict = limiter.check("scope", t0 + 15_000);
    expect(verdict).toEqual({ ok: false, retryAfterSeconds: 45 });
  });

  test("retryAfterSeconds is at least 1 even at the window edge", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    limiter.check("scope", t0);
    const verdict = limiter.check("scope", t0 + 59_999);
    expect(verdict).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  test("a new window opens once the old one expires", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    limiter.check("scope", t0);
    expect(limiter.check("scope", t0 + 1).ok).toBe(false);
    expect(limiter.check("scope", t0 + 60_000)).toEqual({ ok: true });
    // ...and the fresh window enforces the limit again.
    expect(limiter.check("scope", t0 + 60_001).ok).toBe(false);
  });

  test("scopes are counted independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect(limiter.check("a", t0)).toEqual({ ok: true });
    expect(limiter.check("b", t0)).toEqual({ ok: true });
    expect(limiter.check("a", t0 + 1).ok).toBe(false);
    expect(limiter.check("b", t0 + 1).ok).toBe(false);
  });

  test("the tracked-key map is bounded against attacker-chosen scopes", () => {
    // 10k+ distinct scopes must not accumulate without bound: quick-lru's
    // dual-generation eviction caps it at ~2x maxSize.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 30_000; i += 1) limiter.check(`scope-${i}`, t0);
    // The earliest scopes were evicted, so a repeat check opens a fresh
    // window instead of finding the old one — bounded memory, same verdict.
    expect(limiter.check("scope-0", t0 + 1)).toEqual({ ok: true });
  });
});
