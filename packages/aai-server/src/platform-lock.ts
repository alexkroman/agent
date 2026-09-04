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
 * ## It is a Postgres ADVISORY LOCK, on a reserved connection
 *
 * This used to be a lease row per key in `aai_platform.slug_locks`, on the
 * reasoning that "advisory locks are connection-scoped and `SqlExec` runs
 * over a pool, so acquire and release could land on different connections."
 * That constraint is real, and the answer to it is to stop using the pool:
 * `AdminDb.reserve()` (postgres.js `sql.reserve()`) holds ONE connection for
 * the critical section, which is exactly the affinity an advisory lock needs.
 *
 * What that deletes, beyond the table itself:
 *
 * - **The poll loop.** `pg_advisory_lock` QUEUES the waiter inside Postgres,
 *   so a contended acquire costs one blocking statement instead of a 250ms
 *   round trip until the deadline.
 * - **The acquire deadline's implementation.** `lock_timeout` on the
 *   reserved connection makes Postgres enforce it and raise `55P03`, which
 *   is the whole of {@link SlugLockTimeoutError}'s trigger.
 * - **Lease expiry, and its pg_cron sweep.** A dropped connection releases
 *   the lock, so a crashed replica frees its slug immediately rather than
 *   after a lease, and there are no dead rows to collect. (Returning a
 *   reservation to the pool is NOT a drop — session state survives it, so the
 *   explicit `pg_advisory_unlock` is the normal release path.)
 * - **The "not renewed while held" caveat.** There is no lease to outrun: an
 *   operation holds the lock until it finishes, however long that takes.
 *   (The reservation is the new resource to respect — hence the `finally`.)
 *
 * ## Session mode is required
 *
 * A transaction-mode pooler (Supavisor's 6543 port, PgBouncer with
 * `pgbouncer=true`) hands the underlying server connection back after every
 * transaction, so a session-scoped advisory lock taken through one is not
 * held by the client that thinks it holds it. That is silent loss of mutual
 * exclusion, so {@link assertSessionModeUrl} refuses such a URL at
 * construction instead: the platform admin connection must be the direct
 * (session-mode) string.
 *
 * The rule reaches every DIRECT pool on this connection, which now includes the
 * durable-workflow world: `world-postgres` opens a `LISTEN` client with no polling
 * fallback and graphile-worker uses named prepared statements, both of which a
 * transaction pooler breaks silently. The exemption this paragraph used to carry —
 * per-app databases, fronted by the pooler on purpose and taking no advisory locks
 * — is gone with them.
 *
 * The advisory lock still takes the in-process `withSlugLock` first: local
 * waiters queue on the mutex instead of each holding a reserved connection
 * while blocked, and local mutual exclusion with sandbox provisioning
 * (`sandbox.ts`, which stays on the in-process lock — it guards this
 * replica's slot cache, a legitimately process-local resource) is preserved.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { KeyedLockTimeoutError } from "./_keyed-lock.ts";
import { createLogger } from "./logger.ts";
import { sqlState } from "./platform-db-errors.ts";
import { withSlugLock } from "./sandbox-slots.ts";

const log = createLogger("platform.lock");

/** Run `fn` while holding the platform-wide mutation lock for `slug`. */
export type SlugMutationLock = <T>(slug: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Take the in-process mutex under the SAME acquire deadline the Postgres half
 * enforces, and report a lapse as the same error.
 *
 * Both slug-lock paths queue here first, so without this the 15s deadline was
 * only ever reachable by a CROSS-replica waiter: two mutations of one slug on
 * one replica blocked on the mutex indefinitely, and `SlugLockTimeoutError` —
 * hence the retryable 409 — could not be produced. That is not a rare
 * shape. `watchAgentInvalidation` holds this very mutex across
 * `handoverSlot`, which awaits the replacement sandbox's readiness (the 120s
 * boot budget), so a redeploy landing while the previous one is still booting
 * is exactly it, and the Modal function timeout is four hours.
 */
function withSlugMutex<T>(slug: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return withSlugLock(slug, fn, { timeoutMs }).catch((err: unknown) => {
    // One taxonomy for both halves: local contention and remote contention are
    // the same answer to a caller — someone else holds this slug, try again.
    if (err instanceof KeyedLockTimeoutError) throw new SlugLockTimeoutError(slug, { cause: err });
    throw err;
  });
}

/**
 * In-process implementation — the dev/test default, and the fallback when no
 * platform database is configured (single-replica by definition).
 */
export const localSlugLock: SlugMutationLock = (slug, fn) =>
  withSlugMutex(slug, fn, SLUG_LOCK_ACQUIRE_TIMEOUT_MS);

/** The slice of the bundle store the mutation lock has to reach. */
export type InvalidatableStore = { invalidate?: ((slug: string) => void) | undefined };

/**
 * The lock every per-slug mutation route takes: cross-replica exclusion, plus
 * a fresh local view of the slug.
 *
 * Exclusion alone is not enough. Each replica's bundle store caches the
 * agents row (read-through, short TTL), and the mutations are all
 * read-modify-write: `handleSecretSet` merges onto `getEnv`,
 * `handleSecretDelete` deletes a key from it, and `deployLocked` merges both
 * the stored env and the `credential_hashes` off `getAgent`. A row that
 * replica A wrote moments ago can be invisible to replica B's cache — which
 * then computes its merge from a pre-lock snapshot and writes the older
 * value back. The writes were serialized perfectly and one of them still
 * vanished, with no error anywhere: a secret silently reverts, or a deploy
 * silently drops a co-owner's credential hash.
 *
 * Dropping the row cache on lock ACQUISITION is the fix, and it belongs here
 * rather than at each route because a route that forgets produces no error,
 * just an occasional lost write. Entering the critical section is exactly
 * the moment "someone else may have just written this slug" becomes known,
 * so it is the only correct place to distrust the cache.
 *
 * Cheap: an invalidation costs the next reader one row round trip — blob
 * caches are content-addressed and never dropped. `resolveSandbox`
 * deliberately does NOT go through this wrapper — it takes the in-process
 * lock directly; brokering a session mutates nothing.
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

/** Thrown when another holder keeps the lock past the acquire deadline. */
export class SlugLockTimeoutError extends Error {
  constructor(key: string, options?: ErrorOptions) {
    super(`Another operation for ${key} is in progress — retry shortly`, options);
    this.name = "SlugLockTimeoutError";
  }
}

/**
 * Advisory-lock namespace for slug mutations — the first of the two-int key.
 *
 * Two ints rather than one bigint so this namespace can never collide with
 * another advisory-lock user in the same database (Supabase's own tooling
 * included): a collision would be two unrelated operations mysteriously
 * serializing, which is invisible until it is a latency mystery.
 */
export const SLUG_LOCK_NAMESPACE = 0x41_41_49_01;

/**
 * `hashtext` maps the slug into the int4 the second key slot takes. Two
 * different slugs CAN collide there, which costs them contention with each
 * other and nothing else — they are independent mutations, and both still
 * run, one after the other.
 */
const ACQUIRE_SQL = "select pg_advisory_lock($1::int, hashtext($2)::int)";
const RELEASE_SQL = "select pg_advisory_unlock($1::int, hashtext($2)::int)";

/** Postgres error code for a statement that hit `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** How long an acquirer waits on a contended lock before giving up. */
export const SLUG_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;

/**
 * The admin-database slice the platform's own coordination needs: one connection
 * held for a critical section, and a `NOTIFY` subscription.
 *
 * A `Pick` of the real type rather than a second spelling of it — a hand-written
 * copy drifts silently (a `release()` that became async would type-check against
 * the copy and break at runtime), and `Pick` is just as injectable for tests.
 *
 * **`listen` is here rather than on a narrower type of the queue sweep's own**,
 * even though the slug lock does not use it. The alternative was an optional
 * member, and optional would make "this composition cannot listen" a silent
 * degradation to polling instead of a compile error — which is the wrong trade for
 * a signal whose whole purpose is latency. Both members are things a
 * platform-owned connection can always do; a composition that has this handle at
 * all has both.
 *
 * **One TYPE, but not one connection.** `Pick`ing off `CloseableDb` reads as
 * "some pool, minus the parts you may not use", and that is what the platform
 * built for a while — with the `LISTEN` landing on a transaction-pooled handle,
 * where a subscription cannot be held (`service-config.ts` has the account). So
 * read this as a pair of CAPABILITIES rather than as one handle: `reserve` may
 * be pooled, `listen` must be session-mode, and the composition root satisfies
 * the two from two handles. The type is deliberately silent about that — it is
 * the wiring's decision, and a spec asserts it per member.
 */
export type AdminDb = Pick<CloseableDb, "reserve" | "listen">;

export type PgSlugLockOptions = {
  acquireTimeoutMs?: number;
};

/**
 * Does this URL name a TRANSACTION-mode pooler?
 *
 * One spelling, because two callers need the same answer for opposite reasons:
 * {@link assertSessionModeUrl} REFUSES such a URL for the connection that takes
 * session-scoped advisory locks, and `platformPoolerUrl` REQUIRES one for the
 * admin pool, where transaction mode is the only mode that multiplexes. Two
 * copies of the predicate would let those two drift into disagreeing about what
 * a pooler URL is, which is unresolvable by reading either site.
 */
export function isTransactionModePooler(url: URL): boolean {
  return url.port === "6543" || url.searchParams.get("pgbouncer") === "true";
}

/**
 * Refuse a transaction-mode pooler URL: a session-scoped advisory lock taken
 * through one is not held by whoever thinks it holds it (see the module doc).
 * Throwing at construction is the point — the alternative is a lock that
 * appears to work and silently stops excluding anything.
 */
export function assertSessionModeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not our business to validate connection strings in general — the driver
    // will reject an unusable one with a better message than we can.
    return;
  }
  if (isTransactionModePooler(parsed)) {
    throw new Error(
      "SUPABASE_DB_URL points at a TRANSACTION-mode pooler (port 6543 / pgbouncer=true). " +
        "The platform admin connection must be the direct session-mode string: per-slug " +
        "mutation locks are Postgres advisory locks, and a transaction-mode pooler returns " +
        "the server connection between statements, so the lock would stop excluding " +
        "concurrent deploys without any error.",
    );
  }
}

/**
 * Postgres advisory-lock slug lock over the platform admin connection.
 *
 * No DDL, no table, no sweep — the lock lives in Postgres's own lock
 * manager, and a dropped connection releases it.
 */
export function createPgSlugLock(db: AdminDb, opts: PgSlugLockOptions = {}): SlugMutationLock {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? SLUG_LOCK_ACQUIRE_TIMEOUT_MS;

  return (slug, fn) =>
    // Local mutex first: in-process waiters queue here instead of each
    // holding a reserved connection open while blocked on the same lock. It
    // carries the same deadline, so whichever half a waiter is stuck behind it
    // answers 409 after the same wait — see withSlugMutex.
    withSlugMutex(
      slug,
      async () => {
        const reserved = await db.reserve();
        let held = false;
        try {
          // Postgres enforces the acquire deadline and queues the waiter, so
          // there is no poll loop. `lock_timeout` is per-connection state,
          // which is exactly what the reservation buys.
          await reserved.query(`set lock_timeout = ${Math.max(1, Math.round(acquireTimeoutMs))}`);
          try {
            await reserved.query(ACQUIRE_SQL, [SLUG_LOCK_NAMESPACE, slug]);
            held = true;
          } catch (err) {
            if (sqlState(err) === LOCK_NOT_AVAILABLE) {
              throw new SlugLockTimeoutError(slug, { cause: err });
            }
            throw err;
          }
          return await fn();
        } finally {
          // The explicit unlock is the REAL release path: postgres.js
          // `release()` returns the connection to the pool with its session
          // state intact, so an advisory lock survives it — a failed unlock
          // leaks the lock onto a pooled connection, which is why the failure is
          // logged rather than swallowed. (A DROPPED connection does free it;
          // that is the crashed-replica backstop, a different event.) Skipping
          // the unlock when the acquire failed matters too: unlocking a lock
          // this session never took logs a Postgres warning and returns false.
          if (held) {
            await reserved
              .query(RELEASE_SQL, [SLUG_LOCK_NAMESPACE, slug])
              .catch((err: unknown) =>
                log.warn("failed to release slug lock", { slug, error: errorMessage(err) }),
              );
          }
          reserved.release();
        }
      },
      acquireTimeoutMs,
    );
}
