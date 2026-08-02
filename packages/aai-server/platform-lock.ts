// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica mutation lock for per-slug API operations.
 *
 * `withSlugLock` (sandbox-slots.ts) serializes deploy/delete/secret/storage
 * writers within ONE process. Production runs multiple replicas behind a
 * proxy, so two concurrent deploys of the same slug can land on different
 * machines and interleave their storage writes. This module moves that
 * exclusion into the platform's Supabase Postgres — the same
 * `SUPABASE_DB_URL` connection Vault and the studio stores use — so the
 * server process itself holds no cross-request coordination state.
 *
 * Implementation is a lease row per key in `aai_platform.slug_locks`, NOT a
 * Postgres advisory lock: advisory locks are connection-scoped and `SqlExec`
 * runs over a pool, so acquire and release could land on different
 * connections. A lease survives any connection and expires on its own if the
 * holder crashes mid-operation.
 *
 * The lease is not renewed while held. An operation outrunning
 * `leaseMs` loses exclusivity — the same single-concurrent-writer posture as
 * the workspace store's one conflict retry. Deploys (the slowest holder)
 * finish in seconds; the default lease leaves an order-of-magnitude margin.
 *
 * The Postgres lock still takes the in-process `withSlugLock` first: local
 * waiters queue on the mutex instead of hammering the database, and local
 * mutual exclusion with sandbox provisioning (`sandbox.ts`, which stays on
 * the in-process lock — it guards this replica's slot cache, a legitimately
 * process-local resource) is preserved.
 */

import { randomUUID } from "node:crypto";
import { errorMessage } from "@alexkroman1/aai";
import { sleep } from "./_sleep.ts";
import { ensureTableOnce } from "./pg-ensure.ts";
import { withSlugLock } from "./sandbox-slots.ts";
import type { SqlExec } from "./secret-store.ts";

/** Run `fn` while holding the platform-wide mutation lock for `slug`. */
export type SlugMutationLock = <T>(slug: string, fn: () => Promise<T>) => Promise<T>;

/**
 * In-process implementation — the dev/test default, and the fallback when no
 * platform database is configured (single-replica by definition).
 */
export const localSlugLock: SlugMutationLock = withSlugLock;

/** The slice of the bundle store the mutation lock has to reach. */
export type InvalidatableStore = { invalidate?: ((slug: string) => void) | undefined };

/**
 * The lock every per-slug mutation route takes: cross-replica exclusion, plus
 * a fresh local view of the slug.
 *
 * The lease alone is not enough. Each replica's bundle store is a
 * read-through cache (60s for the manifest — which carries the agent's env —
 * and its config), and the mutations are all read-modify-write:
 * `handleSecretSet` merges onto `getEnv`, `handleSecretDelete` deletes a key
 * from it, and `deployLocked` merges both the stored env and the
 * `credential_hashes` off `getManifest`. `putEnv` drops only the writing
 * replica's cache entry, so a write that landed on replica A moments ago is
 * invisible to replica B — which then computes its merge from a pre-lock
 * snapshot and writes the older value back. The lease serialized the two
 * writes perfectly and one of them still vanished, with no error anywhere: a
 * secret silently reverts, or a deploy silently drops a co-owner's
 * credential hash.
 *
 * Dropping the cache on lock ACQUISITION is the fix, and it belongs here
 * rather than at each route for the reason `invalidateSlug` exists: a route
 * that forgets produces no error, just an occasional lost write. Entering the
 * critical section is exactly the moment "someone else may have just written
 * this slug" becomes known, so it is the only correct place to distrust the
 * cache.
 *
 * Cheap: an invalidation costs the next reader one storage round trip, and
 * mutations are rare relative to reads. Note `resolveSandbox` deliberately
 * does NOT go through this — it takes the in-process lock directly, so
 * brokering a session never drops the (up to 30 MB) worker-code cache.
 */
export function createMutationLock(
  lock: SlugMutationLock,
  store: InvalidatableStore,
): SlugMutationLock {
  return (slug, fn) =>
    lock(slug, () => {
      store.invalidate?.(slug);
      return fn();
    });
}

/** Thrown when another holder keeps the lease past the acquire deadline. */
export class SlugLockTimeoutError extends Error {
  constructor(key: string) {
    super(`Another operation for ${key} is in progress — retry shortly`);
    this.name = "SlugLockTimeoutError";
  }
}

const TABLE = "aai_platform.slug_locks";
const ENSURE_TABLE_SQL = `create table if not exists ${TABLE} (
  key text primary key,
  holder text not null,
  expires_at timestamptz not null
)`;

// `returning` only produces a row when the insert landed or the do-update's
// where-clause passed — i.e. exactly when this holder acquired the lease.
const ACQUIRE_SQL = `insert into ${TABLE} as l (key, holder, expires_at)
values ($1, $2, now() + $3::int * interval '1 millisecond')
on conflict (key) do update
  set holder = excluded.holder, expires_at = excluded.expires_at
  where l.expires_at <= now()
returning holder`;

const RELEASE_SQL = `delete from ${TABLE} where key = $1 and holder = $2`;

/** How long one acquired lease excludes other replicas. */
export const SLUG_LOCK_LEASE_MS = 60_000;
/** How long an acquirer polls a contended lease before giving up. */
export const SLUG_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
const ACQUIRE_POLL_MS = 250;

export type PgSlugLockOptions = {
  leaseMs?: number;
  acquireTimeoutMs?: number;
  pollMs?: number;
};

/**
 * Postgres lease-backed slug lock over the platform admin connection.
 * Schema/table are created lazily and memoized, matching the studio
 * workspace store; a failed ensure resets the memo so one transient DDL
 * error doesn't wedge every later mutation.
 */
export function createPgSlugLock(sql: SqlExec, opts: PgSlugLockOptions = {}): SlugMutationLock {
  const leaseMs = opts.leaseMs ?? SLUG_LOCK_LEASE_MS;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? SLUG_LOCK_ACQUIRE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? ACQUIRE_POLL_MS;

  const ensure = ensureTableOnce(sql, ENSURE_TABLE_SQL);

  async function acquire(key: string): Promise<string> {
    const holder = randomUUID();
    const deadline = Date.now() + acquireTimeoutMs;
    for (;;) {
      const rows = await sql(ACQUIRE_SQL, [key, holder, leaseMs]);
      if (rows.length > 0) return holder;
      if (Date.now() >= deadline) throw new SlugLockTimeoutError(key);
      await sleep(pollMs);
    }
  }

  return (slug, fn) =>
    // Local mutex first: in-process waiters queue here instead of polling
    // the database against each other.
    withSlugLock(slug, async () => {
      await ensure();
      const holder = await acquire(slug);
      try {
        return await fn();
      } finally {
        // Best-effort: a failed delete just leaves the lease to expire.
        try {
          await sql(RELEASE_SQL, [slug, holder]);
        } catch (err) {
          console.warn(`Failed to release slug lock for ${slug}: ${errorMessage(err)}`);
        }
      }
    });
}
