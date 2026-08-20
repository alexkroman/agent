// Copyright 2026 the AAI authors. MIT license.
/**
 * WHICH Postgres connection the platform opens for what, and in which mode.
 *
 * Split out of `service-config.ts` (which was over the file-length cap) along a
 * real seam rather than an arbitrary one: these three resolvers answer one
 * question — may this connection be POOLED, and how — and the answer is measured
 * rather than chosen. `supabase/config.toml`'s pooler stanza carries the run:
 *
 * - `SUPABASE_DB_URL` stays DIRECT, because the slug lock is a session-scoped
 *   `pg_advisory_lock` and a rival connection acquired the same lock through a
 *   transaction pooler. That is the silent loss of mutual exclusion
 *   `assertSessionModeUrl` exists to prevent, and it had never been reproduced
 *   before.
 * - The ADMIN pool may be TRANSACTION-pooled: the only lock on it is
 *   `pg_try_advisory_xact_lock` inside `begin … commit`, whose lifetime is
 *   exactly the transaction a pooler pins a backend for — verified correct
 *   including a rival refused while held and release on commit.
 * - App databases must be SESSION-pooled, because they host the Workflow DevKit:
 *   graphile-worker uses NAMED prepared statements, `world-postgres` opens a
 *   `LISTEN` client with no polling fallback, and `workflow-lock-sweep.ts` takes
 *   a session-scoped advisory lock. Transaction mode breaks all three, silently.
 *
 * `platform-connection-config.test.ts` pins every rule here, including the two
 * refusals that read backwards until you see what they prevent.
 */

import { assertSessionModeUrl, isTransactionModePooler } from "./platform-lock.ts";

/**
 * Supavisor's TRANSACTION-mode URL for the platform ADMIN pool, or `undefined`.
 *
 * The opposite mode from {@link appDbPoolerUrl}, and both are forced. Transaction
 * mode is what actually multiplexes — a session-mode pool holds one server
 * connection per client connection for its lifetime and would save nothing — and
 * the admin pool is the one that may use it, because the only lock on it is
 * `pg_try_advisory_xact_lock` inside `begin … commit`, whose lifetime is exactly
 * the transaction a pooler pins a backend for.
 *
 * REFUSES a session-mode URL, which reads backwards until you see what it
 * prevents: a session-mode URL here is silently useless (no multiplexing) while
 * looking configured, so the budget would count on a saving that is not
 * happening. The SLUG-LOCK pool keeps the direct URL regardless — see
 * `platformDbConnectionsPerReplica`.
 */
export function platformPoolerUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PLATFORM_POOLER_URL?.trim();
  if (!raw) return undefined;
  if (!isTransactionModePooler(new URL(raw))) {
    throw new Error(
      "PLATFORM_POOLER_URL must name a TRANSACTION-mode pooler (port 6543 / pgbouncer=true). " +
        "A session-mode pooler holds one server connection per client connection, so it " +
        "multiplexes nothing while making the connection budget claim it does. Leave it " +
        "unset for direct connections.",
    );
  }
  return raw;
}

/**
 * Supavisor's SESSION-mode host for app databases, or `undefined` for direct.
 *
 * Refuses a transaction-mode URL for the same reason `assertSessionModeUrl`
 * refuses one for the admin connection, but on different grounds: there it is
 * advisory locks, here it is that the Workflow DevKit cannot run on transaction
 * pooling at all (prepared statements + LISTEN — `withPoolerHost` carries the
 * detail). Refused rather than accepted, because the failure is silent: the queue
 * appears to work and every parked run stops resuming.
 */
export function appDbPoolerUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.APP_DB_POOLER_URL?.trim();
  if (!raw) return undefined;
  assertSessionModeUrl(raw);
  return raw;
}
