// Copyright 2026 the AAI authors. MIT license.
/**
 * Every Postgres connection one workflow guest may hold against its app role —
 * the whole table, in one place, because the ceiling is enforced by the DATABASE
 * and a term nobody counted is an outage.
 *
 * An app database is provisioned with a `connection limit` chosen by its TIER
 * (`appDbConnectionLimit` in `aai-server/constants.ts`: 4 for storage-only, 10
 * for an app that runs durable workflows). That is
 * not a pool timeout or a soft target: Postgres REFUSES the connection past it,
 * with `too many connections for role "app_<hash>"`, and every consumer in the
 * guest competes for the same number. So the sums below have to be facts rather
 * than estimates — `aai-server/platform-db-budget.test.ts` asserts each against
 * the tier it belongs to, and the limits' own docs point HERE rather than
 * restating the terms, for the reason the section below gives.
 *
 * **Two sums, because the world is CONDITIONAL.** {@link guestAppDbConnections}
 * is the workflow ceiling and {@link storageAppDbConnections} the one a guest
 * that declares no workflows can reach; which tier an app is provisioned at is
 * the owner's declaration, since the platform stores no agent config (see
 * "The platform stores no agent config" in `aai-server/CLAUDE.md`).
 *
 * ## The terms
 *
 * | consumer | why it is its own connection |
 * | --- | --- |
 * | {@link APP_DB_WORLD_POOL_MAX} | the DevKit's `pg.Pool` — storage reads, queue writes, and one connection held for graphile-worker's own `LISTEN` |
 * | {@link APP_DB_WORLD_LISTEN} | `@workflow/world-postgres`'s streamer opens a dedicated `pg.Client` OUTSIDE that pool |
 * | {@link APP_DB_POOL_MAX} | the guest's one app-database handle: `ctx.db`, session state, workflow uploads, the wake hint |
 * | {@link APP_DB_PRESENCE_LOCK} | `host/workflow-lock-sweep.ts` holds a RESERVED connection for the life of the process — its advisory lock is session-scoped, so a pooled one would be released by the wrong statement |
 * | {@link APP_DB_BOOT_SPARE} | not a consumer: the headroom the ROLE's limit owes on top of the four above — the DevKit's migration on boot, and the overlap while a replaced sandbox drains |
 *
 * ## What this table is NOT allowed to be
 *
 * **A count of the pools that happen to exist.** It was exactly that, and it
 * went stale the way a hand-kept list does: it counted the world pool, the
 * `LISTEN` client, `ctx.db` and a spare — four terms, sum 10 — while a real
 * guest also held an upload pool (2), a wake-hint pool (1) and the presence
 * connection (1), for a ceiling of 13 against a limit of 10. The symptom was
 * the marginal consumer failing, which is whichever one asked last:
 * `Workflow wake hint not published { error: 'too many connections for role
 * "app_…"' }` on a guest that had just booted beside a draining sibling.
 *
 * The two structural answers are in the terms above. `APP_DB_POOL_MAX` is ONE
 * handle rather than three because they are the same role on the same URL with
 * no session state between them (`host/app-db.ts` leases it), and every pooled
 * connection is now given back when it goes idle (`host/postgres-db.ts`), so
 * two guests briefly sharing the role hold their RESIDENT connections rather
 * than their ceilings.
 *
 * ## What it does NOT bound: two guests at once
 *
 * The role's limit is per ROLE and a slug legitimately has two guests for a few
 * minutes — the blue-green handover boots the replacement while the old one
 * drains — so two ceilings do not fit and cannot be made to. What makes the
 * overlap survivable is the RESIDENT footprint rather than the ceiling: with
 * idle connections returned (`host/postgres-db.ts`), a guest holding no session
 * and running no step keeps three — graphile-worker's `LISTEN`, the streamer's,
 * and the presence lock — so the draining sibling is 3 of the 10 rather than its
 * whole entitlement. Two guests both at peak can still be refused. That is the
 * honest boundary of this budget, not an oversight: closing it needs the
 * handover not to overlap, or a per-guest limit the role cannot express.
 *
 * ## Concurrency is one BELOW the world pool, and that is a fix
 *
 * graphile-worker takes a connection out of the pool it is handed and keeps it
 * for the process's life to `LISTEN` for `jobs:insert` (verified in
 * graphile-worker 0.16.6: `pgPool.connect(listenForChanges)` in
 * `runTaskListInternal`, released only on shutdown). Its `concurrency` used to
 * be set to the pool size on the argument that "a worker that cannot get a
 * connection is a step waiting on a pool timeout, which reads as a hung run" —
 * which is right, and was the situation being described: N workers, plus the
 * world's own storage queries, against N-1 usable slots.
 */

/**
 * `WORKFLOW_POSTGRES_MAX_POOL_SIZE` — the DevKit world's `pg.Pool`.
 *
 * Pinned because the world's default is node-postgres's, which is 10 — more than
 * a whole app role is entitled to on its own.
 */
export const APP_DB_WORLD_POOL_MAX = 4;

/**
 * `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` — how many steps one guest runs at once.
 *
 * DERIVED, never declared: one slot of the pool belongs to graphile-worker's
 * `LISTEN` client for the life of the process (see the module doc), so this is
 * what is left for workers and for the world's own storage queries.
 */
export const APP_DB_WORLD_WORKER_CONCURRENCY = APP_DB_WORLD_POOL_MAX - 1;

/**
 * `@workflow/world-postgres`'s streamer `LISTEN`, which is a `pg.Client` of its
 * own rather than a pool member — so it is a term here and not inside the pool.
 */
export const APP_DB_WORLD_LISTEN = 1;

/**
 * The guest's ONE app-database handle: `ctx.db`, the session-state backend,
 * workflow uploads and the wake hint, all leased off it (`host/app-db.ts`).
 *
 * Three, so the budget keeps {@link APP_DB_BOOT_SPARE}. A pool that is full
 * QUEUES the next query (postgres.js), where a role at its limit REFUSES the
 * next connection — so a tight pool costs a few milliseconds of latency and a
 * loose one costs a failure, which is the whole reason this number is small.
 */
export const APP_DB_POOL_MAX = 3;

/** The lock sweep's reserved presence connection — see the module doc. */
export const APP_DB_PRESENCE_LOCK = 1;

/**
 * The connection nothing resident holds, and the one term here that is NOT part
 * of {@link guestAppDbConnections}: the role's limit has to be this much larger
 * than the guest's ceiling.
 *
 * Two things need it. The DevKit's migration runs on boot — before the world
 * starts and before any session, so it overlaps almost nothing — and a replaced
 * sandbox is briefly alive beside its replacement, which is the case the wild
 * failure came from: a guest that had just booted beside a draining sibling,
 * whose wake hint was refused the connection.
 */
export const APP_DB_BOOT_SPARE = 1;

/**
 * What one workflow guest may hold at its CEILING.
 *
 * A function rather than a constant so the sum cannot be spelled twice;
 * `aai-server/platform-db-budget.test.ts` compares it, plus
 * {@link APP_DB_BOOT_SPARE}, against the WORKFLOW tier of
 * `appDbConnectionLimit` (`aai-server/constants.ts`).
 */
export function guestAppDbConnections(): number {
  return APP_DB_WORLD_POOL_MAX + APP_DB_WORLD_LISTEN + APP_DB_POOL_MAX + APP_DB_PRESENCE_LOCK;
}

/**
 * What one guest that runs NO durable workflows may hold at its ceiling.
 *
 * Three of the four terms above exist only for the Workflow DevKit, and a guest
 * that declares no workflows never starts the world that opens them:
 * `startWorkflowWorldIfDeclared(state.workflows !== null, …)` in
 * `aai-guest/harness-agent-mode.ts` returns immediately, so the world pool, the
 * streamer's `LISTEN` client and the queue-lock sweep's presence connection are
 * all unallocated. What is left is {@link APP_DB_POOL_MAX} — the one handle
 * `ctx.db`, the session-state backend and workflow uploads are leased off.
 *
 * **This is the term that makes an entitlement worth differentiating.** A voice
 * agent using `ctx.db` for a cart was provisioned at the workflow tier's ceiling
 * and could only ever hold this many, so the difference was budget the platform
 * had promised and no guest could spend — and the budget's scarcest term is
 * exactly `MAX_ACTIVE_APP_DATABASES`, which that promise divides.
 *
 * A function for the same reason its sibling is one, even at one term: the
 * server compares both against the limits it provisions, and a constant
 * re-exported under a second name is the shape that drifts.
 */
export function storageAppDbConnections(): number {
  return APP_DB_POOL_MAX;
}
