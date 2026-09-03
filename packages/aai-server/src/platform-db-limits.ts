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
 * ## They ARE in the per-replica sum, and the allowance is what paid for it
 *
 * These terms could not be added while per-app databases existed: at
 * `MAX_CONTAINERS` of 3 the fleet is `3 x (SLUG_LOCK_POOL_MAX + PLATFORM_WORLD_POOL_MAX
 * + PLATFORM_WORLD_LISTEN + QUEUE_NOTIFY_LISTEN)` direct, and the app-database
 * allowance was 28, against a budget of 40. The two do not fit, and they were never
 * meant to — the allowance existed to give every workflow agent its own six
 * connections, which is exactly the cost this world removes.
 *
 * So the allowance went and the world took its place in the same change, which is
 * what `platform-db-budget.test.ts` asserts — and it asserts it by COMPUTING
 * {@link platformDbConnectionsPerReplica} rather than against a number written
 * here, which is why the sum is spelled as its terms above. A literal total went
 * stale within one change: `QUEUE_NOTIFY_LISTEN` joined the sum and the prose still
 * read `3 x (4 + 5) = 27`, understating the fleet by three.
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
 * as it did when the world ran inside each guest. One per replica now instead of
 * one per workflow agent — which is the whole shape of what moving the world onto
 * the platform's own database bought.
 */
export const PLATFORM_WORLD_LISTEN = 1;

/**
 * The queue sweep's `NOTIFY` listener, which also sits OUTSIDE every pool.
 *
 * One per replica. postgres.js opens a dedicated connection per listening handle
 * and re-issues the `LISTEN` after a reconnect — that reconnect behaviour is the
 * reason to use its `listen()` rather than hand-rolling one on a reserved
 * connection, and a dedicated connection is what a `LISTEN` fundamentally needs
 * (the subscription is session state, so a pooled query cannot hold it).
 *
 * ## It has to be a SESSION-mode connection, and for a while it was not
 *
 * "A pooled query cannot hold it" was written here as a property of a POOL and
 * is really a property of the POOLER: the subscription lives in one backend's
 * session, and a transaction-mode pooler hands that backend to somebody else
 * after every statement. Supavisor does not support `LISTEN` in transaction
 * mode (supabase/supavisor#85, open as an enhancement since May 2023).
 *
 * The sweep nonetheless subscribed through the ADMIN pool, which
 * `PLATFORM_POOLER_URL` routes through exactly that — and NOTHING reported it.
 * `NOTIFY` is an ordinary statement and works pooled, so the announce side
 * succeeded; the subscription itself ESTABLISHED without error and simply
 * received nothing; and `workflow-queue-scheduler.ts`'s `.catch` only fires
 * when a subscription fails to establish. Because the poll interval is a
 * designed fallback, the entire symptom was latency — every step-to-step hop
 * paying the interval again, which reads as "durable workflows are just slow",
 * precisely the failure `WORKFLOW_QUEUE_CHANNEL`'s own doc predicts for a
 * broken announcement. `service-config.ts` gives the `LISTEN` its own handle on
 * `SUPABASE_DB_URL` now, which `assertSessionModeUrl` has already validated.
 *
 * ## Which is what makes this term's arithmetic true
 *
 * Counted here rather than treated as free, because that is exactly the mistake
 * the per-app database allowance made: a connection outside a pool is still a
 * backend on the instance. One per replica is a constant, which is the property
 * this budget needs — see {@link platformDbConnectionsPerReplica}.
 *
 * Note this term counts a DIRECT backend, and until the fix above it was not
 * one: a pooler CLIENT connection costs the instance a share of Supavisor's own
 * pool rather than a `max_connections` slot of its own, so the budget overstated
 * a replica by one. Harmlessly — an overstatement only spends headroom — but the
 * term and the wiring now agree, and the term is why the fix needs no budget
 * change: the connection it moves onto the instance is the one already claimed.
 */
export const QUEUE_NOTIFY_LISTEN = 1;

/**
 * What one replica's world holds at its ceiling.
 *
 * A function rather than a constant so the sum cannot be spelled twice.
 */
export function platformWorldConnections(): number {
  return PLATFORM_WORLD_POOL_MAX + PLATFORM_WORLD_LISTEN;
}

/**
 * DIRECT connections one replica may open against the PRIMARY cluster.
 *
 * There is one cluster now, so the sum is one term plus the world's. It used to
 * take a count of EXTRA placement clusters, and charging them here was a category
 * error worth remembering if per-tenant placement is ever reintroduced: a separate
 * cluster is a separate instance with its own `max_connections`, so its backends
 * never competed with this one's Vault reads, agents-row lookups or slug locks.
 * This budget is calibrated entirely against ONE instance (60 total, ~17 held by
 * Supabase's own workers), and counting another instance's backends into it made
 * sharding look unaffordable BY the very mechanism that relieves the ceiling — one
 * extra cluster took the fleet claim from 40 to 60 against a 40 budget, and the
 * wake sweep recorded "the connection budget cannot currently afford them" as the
 * reason there were none in production.
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
 * - `pg_try_advisory_xact_lock` lives inside `begin … commit`, and a transaction
 *   pooler pins one backend for a transaction — exactly that lock's lifetime:
 *   verified correct end to end when the wake sweep's leader election used it
 *   (acquired, a rival refused while held, released by the commit). That sweep is
 *   retired and the queue sweep that replaced it needs no leader lock at all, so
 *   nothing on the ADMIN pool takes one today; the finding is kept because it is
 *   what makes the pool SAFE to pool, and the next scheduled pass that wants one
 *   should not have to re-derive it.
 *
 * Everything else on the admin pool is a single short query (Vault, agents rows,
 * workspaces, chats, the sweeps' scheduling), `createPostgresDb` already sets
 * `prepare: false`, and nothing on the POOL `LISTEN`s — the three things that
 * make transaction pooling unusable for the Workflow DevKit all fail to apply
 * here.
 *
 * That third clause is TRUE now, and it was FALSE when written: the queue
 * sweep's subscription reaches the platform through the same `AdminDb`, so for
 * as long as `AdminDb.listen` resolved to the admin pool this paragraph claimed
 * the pool never listened one line above a sum that adds
 * {@link QUEUE_NOTIFY_LISTEN} for that very listener — both halves of the
 * contradiction inside one doc comment. `service-config.ts` composes the two members from two handles now —
 * `reserve` from this pool, `listen` from a session-mode handle of its own — so
 * "nothing on the pool listens" describes the wiring instead of contradicting
 * it, and the term below counts a connection that is really direct.
 *
 * With `PLATFORM_POOLER_URL` unset the admin pool is DIRECT and this understates
 * a replica by `ADMIN_POOL_MAX`, so boot announces it rather than leaving the
 * budget quietly wrong.
 */
export function platformDbConnectionsPerReplica(): number {
  return SLUG_LOCK_POOL_MAX + platformWorldConnections() + QUEUE_NOTIFY_LISTEN;
}
