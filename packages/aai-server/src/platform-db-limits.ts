// Copyright 2026 the AAI authors. MIT license.
/**
 * What the platform's own database costs per replica.
 *
 * Its own module rather than entries in `constants.ts`, and not only because that
 * file is at its length cap: the argument for what counts and what does not is one
 * argument. `constants.ts` imports the sum so the fleet budget stays in one place.
 *
 * ## They are DIRECT connections, and that is forced
 *
 * {@link platformDbConnectionsPerReplica} counts only connections that consume
 * `max_connections`. The ADMIN pool is excluded because it reaches the instance
 * through `PLATFORM_POOLER_URL` in transaction mode, which multiplexes it away —
 * a reserved-but-idle client there pins no server backend. What cannot be pooled
 * is what needs SESSION affinity, and that is the whole membership rule: the slug
 * lock holds `pg_advisory_lock` across a deploy, and the queue sweep `LISTEN`s.
 * Both need one fixed backend, so both are direct, and both are in the sum.
 *
 * ## The DevKit world is NOT in it, and used to be
 *
 * This module was written around two terms it no longer has — a
 * `PLATFORM_WORLD_POOL_MAX` of 4 for a `pg.Pool` and a `PLATFORM_WORLD_LISTEN` of
 * 1 for the streamer's dedicated `LISTEN` client — on the premise that relocating
 * the DevKit's Postgres world out of every guest moved those connections onto the
 * platform's own database. The replay engine then replaced the world outright:
 * `aai-runtime/workflow-platform-world.ts` opens with "There is no 'world' left to
 * compose", and its four clients — the journal, the queue, session state and
 * upload records — reach the platform over HTTP with the per-sandbox bearer.
 * Neither `aai-server` nor `aai-runtime` depends on `pg`, `graphile-worker` or
 * `@workflow/world-postgres`, and neither contains a `new Pool`.
 *
 * So the two terms claimed 5 connections per replica, 15 of the fleet's budget,
 * for something that opens none — which is the same shape of error as the
 * tenant-scaled app-database allowance they replaced, one step smaller: an
 * accounting term outliving the code it described. A budget that overstates is
 * not the safe direction it looks like, because `platform-db-capacity.ts`
 * compares it against the real instance at boot and reports the spare, so the
 * overstatement is subtracted from the headroom an operator reads.
 *
 * ## The sum is spelled as its TERMS, never as a total
 *
 * `platform-db-budget.test.ts` asserts by COMPUTING
 * {@link platformDbConnectionsPerReplica} rather than against a number written
 * here. A literal total went stale within one change once already:
 * `QUEUE_NOTIFY_LISTEN` joined the sum and the prose still read `3 x (4 + 5) = 27`,
 * understating the fleet by three.
 */

import { SLUG_LOCK_POOL_MAX } from "./constants.ts";

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
  return SLUG_LOCK_POOL_MAX + QUEUE_NOTIFY_LISTEN;
}
