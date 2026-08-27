// Copyright 2026 the AAI authors. MIT license.
/**
 * What the platform's own database costs per replica, and what the DevKit's world
 * adds to it.
 *
 * Its own module rather than a pair of entries in `constants.ts`, and not only
 * because that file is at its length cap: these two numbers are the price of
 * relocating the world out of every guest, and the argument for them is one
 * argument. `constants.ts` imports the sum so the fleet budget stays in one place.
 *
 * ## They are DIRECT connections, and that is forced
 *
 * `platformDbConnectionsPerReplica` counts only connections that consume
 * `max_connections` — the admin pool is excluded because it goes through the
 * transaction pooler, which multiplexes it away. This pool cannot: the DevKit's
 * streamer `LISTEN`s, and a `LISTEN` needs connection affinity for the same
 * reason a session-scoped advisory lock does. So these are direct, they count,
 * and they are in the sum.
 *
 * ## The trade, stated as numbers
 *
 * Per WORKFLOW AGENT, the in-guest world cost four pooled connections plus a
 * dedicated `LISTEN` client plus the queue-lock sweep's presence connection, none
 * of them shareable, against a role limited to ten — the ceiling the whole arc was
 * about. Here it is {@link platformWorldConnections} per REPLICA, shared by every
 * agent on it. At `MAX_CONTAINERS` of 3 that is a fixed fleet-wide cost, so the
 * break-even is two workflow agents and the improvement grows linearly after that.
 *
 * ## They are NOT in the per-replica sum yet, and that is the sequencing
 *
 * {@link platformDbConnectionsPerReplica} counts what is RUNNING, and nothing
 * constructs this world yet — an unwired pool costs no connections. What matters is
 * that it cannot simply be added later either: at `MAX_CONTAINERS` of 3, the fleet
 * is `3 x (4 + 5) = 27` direct, and the app-database allowance is 28, against a
 * budget of 40. Those two terms do not fit together, and they are not meant to —
 * the allowance exists to give every workflow agent its own six connections, which
 * is the cost this world removes.
 *
 * So the world enters the sum in the SAME change that removes
 * `APP_DB_CONNECTION_ALLOWANCE`, and `platform-db-budget.test.ts` asserts the
 * arithmetic of that end state (`27 <= 40`) rather than leaving it to be
 * rediscovered. A branch that wires the world without dropping the allowance fails
 * the budget it was already failing — loudly, with the numbers.
 */

import { SLUG_LOCK_POOL_MAX } from "./constants.ts";

/**
 * `pg.Pool` size for the platform's world — storage reads and the one mutation.
 *
 * PINNED because their default is node-postgres's, which is 10 per replica and
 * would put the fleet over its direct-connection budget on its own. Four is sized
 * against what a request actually needs: `events.create` is one transaction, and
 * the read routes are single queries, so this is a concurrency ceiling on storage
 * requests rather than a working-set requirement.
 */
export const PLATFORM_WORLD_POOL_MAX = 4;

/**
 * The streamer's dedicated `pg.Client`, which sits OUTSIDE the pool.
 *
 * Not a pool member: their streamer opens its own client to `LISTEN` on, exactly
 * as it did inside each guest (`aai/sdk/app-db-budget.ts` recorded the same term
 * there). One per replica now instead of one per workflow agent.
 */
export const PLATFORM_WORLD_LISTEN = 1;

/**
 * What one replica's world holds at its ceiling.
 *
 * A function rather than a constant so the sum cannot be spelled twice — the same
 * reason `guestAppDbConnections()` is one.
 */
export function platformWorldConnections(): number {
  return PLATFORM_WORLD_POOL_MAX + PLATFORM_WORLD_LISTEN;
}

/**
 * DIRECT connections one replica may open against the PRIMARY cluster.
 *
 * **It used to take an `extraAppDbTargets` count, and charging them here was a
 * category error.** An extra `APP_DB_URLS` cluster is a separate Supabase
 * project (`app-db-admin.ts`: "a fleet is several Supabase projects, and the ref
 * is per cluster"), and `extraAppDbTargets` pools
 * {@link APP_DB_TARGET_POOL_MAX} against THAT project's URL — so those
 * connections land on that project's `max_connections` and never compete with
 * the primary's Vault reads, agents-row lookups or slug locks. This budget is
 * calibrated entirely against one instance (60 total, ~17 held by Supabase's own
 * workers), so counting another instance's backends into it made sharding look
 * unaffordable BY the very mechanism that relieves the ceiling: one extra
 * cluster took the fleet claim from 40 to 60 against a 40 budget, and
 * `workflow-wake.ts` recorded "the connection budget cannot currently afford
 * them" as the reason there were none in production. An extra cluster's own
 * claim is {@link appDbClusterConnectionsPerReplica}, checked against that
 * cluster.
 *
 * **The ADMIN pool is not in this sum, because it is POOLED**
 * (`PLATFORM_POOLER_URL`, transaction mode). What decides whether a pool may be
 * pooled is whether anything on it needs SESSION affinity, and only one thing
 * does — measured against a real Supavisor in transaction mode:
 *
 * - `pg_advisory_lock`, the SLUG lock, is session-scoped and held across a whole
 *   deploy. Through the pooler a RIVAL connection acquired the same lock while it
 *   was held: mutual exclusion silently gone. That is the bug
 *   `assertSessionModeUrl` exists to prevent, and it stays DIRECT.
 * - `pg_try_advisory_xact_lock`, the wake sweep's leader election, is the only
 *   lock on the ADMIN pool and lives inside `begin … commit`. A transaction
 *   pooler pins one backend for a transaction, which is exactly that lock's
 *   lifetime: verified correct end to end — acquired, a rival refused while held,
 *   released by the commit.
 *
 * Everything else on the admin pool is a single short query (Vault, agents rows,
 * workspaces, chats, the sweeps' scheduling), `createPostgresDb` already sets
 * `prepare: false`, and nothing on it ever `LISTEN`s — the three things that make
 * transaction pooling unusable for the Workflow DevKit all fail to apply here.
 *
 * With `PLATFORM_POOLER_URL` unset the admin pool is DIRECT and this understates
 * a replica by `ADMIN_POOL_MAX`, so boot announces it rather than leaving the
 * budget quietly wrong.
 */
export function platformDbConnectionsPerReplica(): number {
  return SLUG_LOCK_POOL_MAX;
}
