// Copyright 2026 the AAI authors. MIT license.
/**
 * Fixed-window rate limiting — the platform's shared primitive.
 *
 * It lived in `aai-studio-server/studio-rate-limit.ts`, because the studio's
 * two expensive routes were the only callers. The agent surface needed it too
 * and could not have it: `aai-server` is the shared core and must never import
 * from the studio, so `POST /deploy` — which claims a slug and, one broker
 * call later, boots a Modal sandbox — had no limiter of any kind. The POLICY
 * stays with each consumer (the studio keeps its window constants); only the
 * mechanism moved down here.
 *
 * Two implementations behind one async interface:
 *
 * - `createRateLimiter` — in-memory windows in a `TtlCache` (an LRU with the
 *   window as its TTL), for local dev and tests. Attacker-chosen keys cannot
 *   grow it without bound: stale windows expire on read and the LRU cap evicts
 *   beyond `maxKeys` — EXACTLY beyond it, since that cache moved to lru-cache.
 * - `createPgRateLimiter` — windows in `aai_platform.studio_rate_limits`
 *   over the platform's Supabase Postgres, so a limit holds across replicas
 *   instead of multiplying by the replica count. That difference is the whole
 *   point for an ABUSE limit: at `MAX_CONTAINERS` (3, in modal_deploy.py), a
 *   per-replica cap is a cap of three times the number written down — and
 *   choosing it is a COMPOSITION decision, so see `createPgAgentRateLimiters`
 *   below for how the agent surface's three are handed over as one thing, and
 *   what it cost when they were handed over one at a time. One atomic upsert per
 *   check; a database error propagates (fail-closed) rather than silently
 *   unmetering the route. Expired rows are swept by pg_cron (pg-cron.ts).
 *
 * The table name still says `studio_` — renaming it is a migration for no
 * behavioural gain, and `name` already namespaces each limiter's rows, which
 * is what lets a second consumer share the table without one.
 */

import { invariant } from "@alexkroman1/aai/internal";
import { TtlCache } from "./_ttl-cache.ts";
import type { SqlExec } from "./secret-store.ts";

/** LRU cap on tracked keys per limiter. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * The window every per-IP limit uses. One number because these are all the
 * same kind of control — "no single host may hammer this" — and having them
 * agree makes the limits comparable to each other at a glance.
 */
export const CLIENT_IP_RATE_LIMIT_WINDOW_MS = 5 * 60_000;

/**
 * `POST /deploy`, per client IP. The route had NO limiter, which mattered
 * more than it looks: a deploy claims a slug, writes content-addressed blobs
 * that are never reclaimed, and leaves behind an agent whose first
 * `client-config` boots a Modal sandbox.
 *
 * Deliberately generous — a developer iterating, or a studio publishing on
 * every settled edit, is a legitimate burst — because this is an abuse bound
 * and not a quota. The per-request memory cost is bounded separately by
 * `DEPLOY_BODY_CONCURRENCY` (constants.ts), which is the control that stops
 * a burst hurting even while it is within this limit.
 */
export const DEPLOY_IP_RATE_LIMIT = {
  limit: 60,
  windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS,
} as const;

/**
 * The whole `/:slug/workflows/*` surface, per client IP.
 *
 * Sized for a POLLING page rather than for a human: `useWorkflowRun` falls back
 * to a read every 2 s (`DEFAULT_WORKFLOW_POLL_MS` in aai-ui) when the event
 * stream is unavailable — 150 reads in this window from one legitimate tab, and
 * a page may watch more than one run. Generous is therefore the only correct
 * setting for the surface limit — the thing actually worth bounding is starting
 * runs, which has its own much tighter limit below.
 */
export const WORKFLOW_IP_RATE_LIMIT = {
  limit: 600,
  windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS,
} as const;

/**
 * `POST /:slug/workflows/runs` — starting runs — per client IP, counted IN
 * ADDITION to {@link WORKFLOW_IP_RATE_LIMIT}.
 *
 * Much tighter, because this is the one route on the surface whose cost
 * OUTLIVES its request: a run keeps executing, keeps the sandbox resident, and
 * keeps spending the tenant's provider budget long after the POST answered 202.
 * Everything else here is a read. A caller doing nothing but starting runs hits
 * this first, which is the point of having both.
 */
export const WORKFLOW_START_IP_RATE_LIMIT = {
  limit: 60,
  windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS,
} as const;

type Window = { count: number; resetAt: number };

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export type RateLimiter = {
  /**
   * Count one request against `key`; refuse once the window's limit is hit.
   *
   * **`now` is a TEST SEAM the Postgres implementation deliberately ignores**,
   * and the signature has always read as though both honoured it. The durable
   * limiter computes its window from the DATABASE's `now()` on purpose — the
   * whole reason the limit is a row is that replicas must not compare their own
   * clocks against each other's, and honouring a caller-supplied instant would
   * hand one replica's skew the power to reopen a window. So it is `check(key)`
   * there, silently dropping the argument.
   *
   * Found by the conformance table (`store-conformance.ts`), which is the point
   * of running one case list over both arms: `check(key, t0 + windowMs + 500)`
   * starts a fresh window in memory and is refused against Postgres. Nothing had
   * ever passed `now` to the pg limiter, so the divergence was invisible.
   * Production callers pass no `now` at all — it is only ever supplied by a test
   * — so this is a documentation fix rather than a behaviour change, and a
   * conformance case may not depend on it.
   */
  check(key: string, now?: number): Promise<RateLimitVerdict>;
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
  return {
    async check(key) {
      const rows = await sql(CHECK_SQL, [options.name, key, options.windowMs]);
      const row = rows[0];
      // `CHECK_SQL` is an upsert with a `returning` clause and no `where` on the
      // insert, so it answers exactly one row for every input — a property of a
      // statement written right here, not of what the caller asked for. The
      // index read is only unchecked because `noUncheckedIndexedAccess` cannot
      // see that.
      invariant(row !== undefined, "ratelimit.upsert.row", () => ({
        limiter: options.name,
        key,
        rows: rows.length,
      }));
      const count = Number(row.count);
      if (count <= options.limit) return { ok: true };
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds) || 1),
      };
    },
  };
}

/**
 * Every limiter the AGENT surface runs, built together — the shape
 * `createOrchestrator` takes, so a composition root spreads it and is done.
 *
 * **It is one function because the alternative was measured and failed.** The
 * three windows above are the orchestrator's whole rate-limit policy, and the
 * composition root (`aai-studio-server/index.ts`) passed exactly ONE of them:
 * `deployRateLimiter`, wired by the audit that added it. The two workflow
 * limiters landed later with their own `?:` options, their own middleware and
 * their own tests, and nothing connected them to the entry — so in production
 * `createWorkflowRateLimitMw` fell through to `?? createRateLimiter(…)` and the
 * `/:slug/workflows/*` surface was metered PER REPLICA. At `MAX_CONTAINERS = 3`
 * that is a 600/IP window enforcing 1,800, and the tighter start limit — the one
 * bounding the only route whose cost outlives its request — enforcing 180 rather
 * than 60. Every test passed: the middleware's own specs inject limiters, so they
 * never see the default, and the entry has no spec at all.
 *
 * A per-limiter builder makes forgetting the next one free. One builder makes the
 * whole policy one spread at the call site, and `rate-limit.test.ts` reads
 * `orchestrator.ts` for `RateLimiter` options this does not answer — so the gate
 * holds for the NEXT one too, which a type cannot promise while every option is
 * optional with an in-memory default behind it.
 *
 * Without a platform database there is no `sql` and no caller: one process means
 * the in-memory default IS fleet-wide, which is why the entry passes nothing
 * rather than passing a memory-backed copy of the same thing.
 */
export function createPgAgentRateLimiters(sql: SqlExec): {
  deployRateLimiter: RateLimiter;
  workflowRateLimiter: RateLimiter;
  workflowStartRateLimiter: RateLimiter;
} {
  return {
    deployRateLimiter: createPgRateLimiter(sql, { name: "deploy-ip", ...DEPLOY_IP_RATE_LIMIT }),
    workflowRateLimiter: createPgRateLimiter(sql, {
      name: "workflow-ip",
      ...WORKFLOW_IP_RATE_LIMIT,
    }),
    workflowStartRateLimiter: createPgRateLimiter(sql, {
      name: "workflow-start-ip",
      ...WORKFLOW_START_IP_RATE_LIMIT,
    }),
  };
}
