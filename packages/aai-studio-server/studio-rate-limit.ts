// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-scope rate limiting for the studio's expensive routes.
 *
 * Studio auth accepts any non-empty bearer key (workspace scoping is all it
 * needs), so without a cap session brokering is unmetered Modal sandbox
 * spawning and project creation is unmetered storage growth. (Chat turns
 * themselves run browser→guest on the caller's own LLM key, so they need no
 * platform metering.) A small fixed-window limiter keyed by the caller's
 * `studioScope` bounds both routes.
 *
 * Two implementations behind one async interface:
 *
 * - `createRateLimiter` — in-memory windows in a `TtlCache` (quick-lru with
 *   the window as max-age), for local dev and tests. Attacker-chosen scopes
 *   cannot grow it without bound: stale windows expire on read and the LRU
 *   cap evicts beyond `maxKeys`.
 * - `createPgRateLimiter` — windows in `aai_platform.studio_rate_limits`
 *   over the platform's Supabase Postgres, so the limit holds across
 *   replicas instead of multiplying by the replica count. One atomic upsert
 *   per check; a database error propagates (fail-closed) rather than
 *   silently unmetering the route. Expired rows are swept by the platform's
 *   pg_cron job (aai-server/pg-cron.ts), not in-process.
 */

import { ensureTableOnce } from "aai-server/pg-ensure";
import { TtlCache } from "aai-server/platform-barrel";
import type { SqlExec } from "aai-server/secret-store";

/** `POST /studio/projects/:project/session` — each request can spawn a Modal sandbox. */
export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 5 * 60_000 } as const;
/** `POST /studio/projects` — each request writes a new workspace document. */
export const PROJECT_CREATE_RATE_LIMIT = { limit: 60, windowMs: 60 * 60_000 } as const;

/** LRU cap on tracked scopes per limiter. */
const MAX_TRACKED_KEYS = 10_000;

type Window = { count: number; resetAt: number };

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export type RateLimiter = {
  /** Count one request against `key`; refuse once the window's limit is hit. */
  check(key: string, now?: number): Promise<RateLimitVerdict>;
};

/** The studio's pair of limiters, injectable per orchestrator. */
export type StudioRateLimiters = {
  chat: RateLimiter;
  projectCreate: RateLimiter;
};

export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const windows = new TtlCache<Window>(options.windowMs, MAX_TRACKED_KEYS);
  return {
    check(key, now = Date.now()) {
      const entry = windows.get(key);
      // The explicit `resetAt` check (not just the cache TTL) keeps the
      // window correct even when a caller supplies its own clock.
      if (!entry || entry.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return Promise.resolve({ ok: true });
      }
      if (entry.count < options.limit) {
        entry.count += 1;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      });
    },
  };
}

const TABLE = "aai_platform.studio_rate_limits";
const ENSURE_TABLE_SQL = `create table if not exists ${TABLE} (
  name text not null,
  key text not null,
  count integer not null,
  reset_at timestamptz not null,
  primary key (name, key)
)`;

// The pg_cron sweep (aai-server/pg-cron.ts) filters on reset_at; index it
// or every hourly sweep pays a sequential scan of the table.
const ENSURE_INDEX_SQL = `create index if not exists studio_rate_limits_reset_at
on ${TABLE} (reset_at)`;

// One atomic statement: start a fresh window when the stored one has
// expired, otherwise bump its counter. `returning` reports the verdict
// inputs, with the remaining window computed database-side so replicas never
// compare their own clocks against each other's.
const CHECK_SQL = `insert into ${TABLE} as t (name, key, count, reset_at)
values ($1, $2, 1, now() + $3::int * interval '1 millisecond')
on conflict (name, key) do update set
  count = case when t.reset_at <= now() then 1 else t.count + 1 end,
  reset_at = case when t.reset_at <= now()
    then now() + $3::int * interval '1 millisecond' else t.reset_at end
returning count, ceil(extract(epoch from (reset_at - now()))) as retry_after_seconds`;

/**
 * Postgres-backed fixed-window limiter over the platform admin connection.
 * `name` namespaces this limiter's rows so several limiters share the table.
 */
export function createPgRateLimiter(
  sql: SqlExec,
  options: { name: string; limit: number; windowMs: number },
): RateLimiter {
  const ensure = ensureTableOnce(sql, ENSURE_TABLE_SQL, ENSURE_INDEX_SQL);

  return {
    async check(key) {
      await ensure();
      const rows = await sql(CHECK_SQL, [options.name, key, options.windowMs]);
      const row = rows[0];
      if (!row) throw new Error(`Rate-limit upsert returned no row for ${options.name}/${key}`);
      const count = Number(row.count);
      if (count <= options.limit) return { ok: true };
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds) || 1),
      };
    },
  };
}
