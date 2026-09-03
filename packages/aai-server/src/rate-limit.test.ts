// Copyright 2026 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { clientIp, UNKNOWN_CLIENT_IP } from "./client-ip.ts";
import {
  createPgAgentRateLimiters,
  createPgRateLimiter,
  createRateLimiter,
  DEPLOY_IP_RATE_LIMIT,
  WORKFLOW_IP_RATE_LIMIT,
  WORKFLOW_START_IP_RATE_LIMIT,
} from "./rate-limit.ts";
import type { SqlExec } from "./secret-store.ts";
import { rateLimiterConformance } from "./store-conformance-cases.ts";

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// One case list in `store-conformance.ts`, shared with the stack arm in
// `store-conformance.scenario.test.ts`. The memory arm is unconditional, so this
// module stays covered on every machine; the stack arm adds what only a real
// Postgres can hold. The suites below keep whatever each implementation
// uniquely owes — the statements it issues, and its own edge cases.

describe("RateLimiter conformance: memory", () => {
  rateLimiterConformance((opts) => createRateLimiter(opts));
});

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

  // The table is declared in supabase/migrations, applied before any code
  // runs. Lazy DDL here would hide a missed migration.
  test("issues no DDL — the table comes from migrations", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeRateLimitDb(clock);
    const limiter = createPgRateLimiter(db.exec, { name: "chat", limit: 5, windowMs: 60_000 });
    await limiter.check("scope");
    await limiter.check("scope");
    expect(db.statements.filter((s) => /^\s*(create|alter)/i.test(s))).toEqual([]);
  });

  test("a database error propagates instead of unmetering the route", async () => {
    const exec: SqlExec = (query) =>
      query.startsWith("create") ? Promise.resolve([]) : Promise.reject(new Error("db down"));
    const limiter = createPgRateLimiter(exec, { name: "chat", limit: 5, windowMs: 60_000 });
    await expect(limiter.check("scope")).rejects.toThrow("db down");
  });
});

// ── The agent surface's limiters, as the composition root gets them ─────────
//
// `createPgAgentRateLimiters` exists because the entry passed ONE of the three
// for months (see its doc). These are the two claims that would have caught
// that: the factory answers every limiter option the orchestrator reads, and
// each one carries the window it is named for. The half only a real database
// can hold — that two instances over one `sql` share a BUDGET, where two
// in-memory ones do not — is `agent-rate-limits.scenario.test.ts`.

describe("createPgAgentRateLimiters", () => {
  test("names each limiter and carries the window it is named for", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeRateLimitDb(clock);
    const limiters = createPgAgentRateLimiters(db.exec);
    await limiters.deployRateLimiter.check("ip");
    await limiters.workflowRateLimiter.check("ip");
    await limiters.workflowStartRateLimiter.check("ip");
    // The fake keys its rows `${name}/${key}` and stores `resetAt`, so the row
    // set is both the namespacing and the window, read back together.
    expect([...db.rows].map(([k, row]) => [k, row.resetAt - clock.now])).toEqual([
      ["deploy-ip/ip", DEPLOY_IP_RATE_LIMIT.windowMs],
      ["workflow-ip/ip", WORKFLOW_IP_RATE_LIMIT.windowMs],
      ["workflow-start-ip/ip", WORKFLOW_START_IP_RATE_LIMIT.windowMs],
    ]);
  });

  /**
   * The gate the missing wiring needed, and the reason this reads SOURCE.
   *
   * Every limiter option on `OrchestratorOpts` is `?:` with an in-memory `??`
   * default behind it, so a forgotten one is not a type error anywhere — it is a
   * green build serving a per-replica limit. A text scan is what respects that:
   * a new `foo?: RateLimiter` fails here until the factory answers it, and the
   * composition root spreads the factory whole.
   */
  test("answers EVERY RateLimiter option the orchestrator reads", () => {
    const source = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const options = [...source.matchAll(/^\s{2}(\w+)\?: RateLimiter;$/gm)].map((m) => m[1]);
    // A scan whose whole output is a list prints the same pass when it matches
    // nothing; three is what the surface has today and the floor under a rename.
    expect(options.length).toBeGreaterThanOrEqual(3);
    const answered = Object.keys(createPgAgentRateLimiters(fakeRateLimitDb({ now: 0 }).exec));
    expect([...options].sort()).toEqual([...answered].sort());
  });
});

describe("a caller with no X-Forwarded-For", () => {
  const headerless = new Request("http://platform.test/a/workflows/runs", { method: "POST" });

  test("keys on the literal `unknown`, which is a value rows are written under", () => {
    // Pinned as a STRING, not just as the constant: it is the `key` column of
    // every `aai_platform.studio_rate_limits` row a header-less caller writes,
    // so changing it silently abandons whatever window is in flight.
    expect(UNKNOWN_CLIENT_IP).toBe("unknown");
    expect(clientIp(headerless)).toBe(UNKNOWN_CLIENT_IP);
  });

  test("shares ONE bucket with every other header-less caller", async () => {
    // The documented trade in client-ip.ts: a shared bucket OVER-limits rather
    // than opening, so it is the safe half of a wrong answer — and it is also a
    // way for one such caller to spend everyone else's budget. Production is
    // behind Modal's proxy, which always appends a hop, so this is the shape a
    // deployment that STRIPS the header would run; deriving a better key needs
    // something the platform can attribute a request to, and this surface is
    // deliberately credential-free.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const other = new Request("http://platform.test/b/workflows/runs");
    await expect(limiter.check(clientIp(headerless))).resolves.toEqual({ ok: true });
    expect((await limiter.check(clientIp(other))).ok).toBe(false);
  });

  test("two in-memory limiters do NOT share it — the whole reason for the pg arm", async () => {
    // One replica each. This is the state the composition root left production
    // in for the workflow surface, and the contrast the scenario suite's
    // Postgres arm asserts the other side of.
    const replicaA = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const replicaB = createRateLimiter({ limit: 1, windowMs: 60_000 });
    await expect(replicaA.check(UNKNOWN_CLIENT_IP)).resolves.toEqual({ ok: true });
    await expect(replicaB.check(UNKNOWN_CLIENT_IP)).resolves.toEqual({ ok: true });
  });
});
