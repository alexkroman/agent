// Copyright 2026 the AAI authors. MIT license.

import type { SqlExec } from "aai-server/secret-store";
import { describe, expect, test } from "vitest";
import { createPgRateLimiter, createRateLimiter } from "./studio-rate-limit.ts";

describe("createRateLimiter", () => {
  test("allows up to the limit within a window, then refuses", async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    await expect(limiter.check("scope", t0)).resolves.toEqual({ ok: true });
    await expect(limiter.check("scope", t0 + 1)).resolves.toEqual({ ok: true });
    await expect(limiter.check("scope", t0 + 2)).resolves.toEqual({ ok: true });
    const verdict = await limiter.check("scope", t0 + 3);
    expect(verdict.ok).toBe(false);
  });

  test("reports how long until the window resets", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    await limiter.check("scope", t0);
    const verdict = await limiter.check("scope", t0 + 15_000);
    expect(verdict).toEqual({ ok: false, retryAfterSeconds: 45 });
  });

  test("retryAfterSeconds is at least 1 even at the window edge", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    await limiter.check("scope", t0);
    const verdict = await limiter.check("scope", t0 + 59_999);
    expect(verdict).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  test("a new window opens once the old one expires", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    await limiter.check("scope", t0);
    expect((await limiter.check("scope", t0 + 1)).ok).toBe(false);
    await expect(limiter.check("scope", t0 + 60_000)).resolves.toEqual({ ok: true });
    // ...and the fresh window enforces the limit again.
    expect((await limiter.check("scope", t0 + 60_001)).ok).toBe(false);
  });

  test("scopes are counted independently", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    await expect(limiter.check("a", t0)).resolves.toEqual({ ok: true });
    await expect(limiter.check("b", t0)).resolves.toEqual({ ok: true });
    expect((await limiter.check("a", t0 + 1)).ok).toBe(false);
    expect((await limiter.check("b", t0 + 1)).ok).toBe(false);
  });

  test("the tracked-key map is bounded against attacker-chosen scopes", async () => {
    // 10k+ distinct scopes must not accumulate without bound: quick-lru's
    // dual-generation eviction caps it at ~2x maxSize.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 30_000; i += 1) await limiter.check(`scope-${i}`, t0);
    // The earliest scopes were evicted, so a repeat check opens a fresh
    // window instead of finding the old one — bounded memory, same verdict.
    await expect(limiter.check("scope-0", t0 + 1)).resolves.toEqual({ ok: true });
  });
});

// ── Postgres-backed limiter ─────────────────────────────────────────────────

/**
 * Fake `SqlExec` reproducing the semantics of the limiter's one upsert (fresh
 * window when expired, else increment) over an in-memory table, with an
 * injectable clock. Statements are matched on shape, so the JS-side verdict
 * mapping gets exercised without a real database. (Expired-row cleanup is a
 * pg_cron job now — see aai-server/pg-cron.ts — not the limiter's concern.)
 */
function fakeRateLimitDb(clock: { now: number }) {
  const rows = new Map<string, { count: number; resetAt: number }>();
  const statements: string[] = [];
  const exec: SqlExec = (query, params) => {
    statements.push(query);
    if (query.startsWith("create")) return Promise.resolve([]);
    // The check upsert.
    const [name, key, windowMs] = params as [string, string, number];
    const k = `${name}/${key}`;
    const existing = rows.get(k);
    const row =
      !existing || existing.resetAt <= clock.now
        ? { count: 1, resetAt: clock.now + windowMs }
        : { count: existing.count + 1, resetAt: existing.resetAt };
    rows.set(k, row);
    return Promise.resolve([
      {
        count: row.count,
        retry_after_seconds: Math.ceil((row.resetAt - clock.now) / 1000),
      },
    ]);
  };
  return { exec, rows, statements };
}

describe("createPgRateLimiter", () => {
  test("allows up to the limit, then refuses with the window's retry-after", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeRateLimitDb(clock);
    const limiter = createPgRateLimiter(db.exec, { name: "chat", limit: 2, windowMs: 60_000 });
    await expect(limiter.check("scope")).resolves.toEqual({ ok: true });
    clock.now += 15_000;
    await expect(limiter.check("scope")).resolves.toEqual({ ok: true });
    await expect(limiter.check("scope")).resolves.toEqual({ ok: false, retryAfterSeconds: 45 });
  });

  test("a new window opens once the stored one expires", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeRateLimitDb(clock);
    const limiter = createPgRateLimiter(db.exec, { name: "chat", limit: 1, windowMs: 60_000 });
    await limiter.check("scope");
    expect((await limiter.check("scope")).ok).toBe(false);
    clock.now += 60_000;
    await expect(limiter.check("scope")).resolves.toEqual({ ok: true });
  });

  test("limiter names namespace their keys", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeRateLimitDb(clock);
    const a = createPgRateLimiter(db.exec, { name: "a", limit: 1, windowMs: 60_000 });
    const b = createPgRateLimiter(db.exec, { name: "b", limit: 1, windowMs: 60_000 });
    await expect(a.check("scope")).resolves.toEqual({ ok: true });
    await expect(b.check("scope")).resolves.toEqual({ ok: true });
    expect((await a.check("scope")).ok).toBe(false);
  });

  test("ensures schema and table before the first check, once", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeRateLimitDb(clock);
    const limiter = createPgRateLimiter(db.exec, { name: "chat", limit: 5, windowMs: 60_000 });
    await limiter.check("scope");
    await limiter.check("scope");
    expect(db.statements.filter((s) => s.startsWith("create")).length).toBe(3); // schema + table + index
  });

  test("a database error propagates instead of unmetering the route", async () => {
    const exec: SqlExec = (query) =>
      query.startsWith("create") ? Promise.resolve([]) : Promise.reject(new Error("db down"));
    const limiter = createPgRateLimiter(exec, { name: "chat", limit: 5, windowMs: 60_000 });
    await expect(limiter.check("scope")).rejects.toThrow("db down");
  });
});
