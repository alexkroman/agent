---
summary: >-
  The platform's own Postgres coordination: the per-slug mutation lock, the
  connection budget and pool routing, the admin pool as a throughput bound,
  and the PlatformEvents change-signal rules.
read_when: >-
  editing anything in `aai-server/src/platform/` — locks, pools, db budget or
  capacity, `_route.ts`, events, platform tables.
---

# packages/aai-server/src/platform — locks, pools, events

Package-wide rules (stateless server, the two sentinels, store conformance) are
in `packages/aai-server/CLAUDE.md`; the tables' write budget and retention are
in [`SCHEMA-CLAUDE.md`](../../SCHEMA-CLAUDE.md); the guest→platform socket in
[`PLATFORM-SOCKET-CLAUDE.md`](../../PLATFORM-SOCKET-CLAUDE.md).

## Per-slug mutation lock (`lock.ts`)

- Deploy/delete/secret mutations for a slug run under a **Postgres advisory
  lock** (`createPgSlugLock`), injected as the `slugLock` binding. It holds ONE
  connection via `AdminDb.reserve()` (postgres.js `sql.reserve()`) for the
  critical section, because advisory locks are connection-scoped and a pool
  could acquire and release on different connections. A dropped connection
  releases the lock, so a crashed replica frees its slug immediately.
- Key: `pg_advisory_lock(SLUG_LOCK_NAMESPACE, hashtext(slug))` — two ints so the
  namespace cannot collide with another advisory-lock user.
- Acquire deadline is `lock_timeout` on that connection: `55P03` →
  `SlugLockTimeoutError` → 409.
- The in-process `withSlugLock` is taken FIRST (so a local waiter does not hold
  a reserved connection while blocked), and carries the **same deadline**
  (`KeyedLockTimeoutError` → `SlugLockTimeoutError`). A waiter that gives up
  must resolve its place in the chain, or everyone behind it blocks forever.
  `watchAgentInvalidation` holds the mutex across `handoverSlot`'s 120s boot, so
  same-replica contention is real.
- `sandbox/resolve.ts` stays on the in-process lock deliberately: it guards
  this replica's slot cache, a process-local resource.

**The binding is wrapped in `createMutationLock` and must stay wrapped: taking
the lock also drops this replica's cached view of the slug.** Every mutation is
a read-modify-write over a read-through row cache (`handleSecretSet` merges onto
`getEnv`; `deployLocked` merges env and `credential_hashes` off `getAgent`), so
without the drop a serialized write can still silently revert another
replica's. Invalidation lives at acquisition (one place) because a route that
forgets produces no error. Only row caches are dropped (blobs are
content-addressed). The broker path does NOT use this wrapper — it mutates
nothing.

## Connection budget (`db-limits.ts`, `db-capacity.ts`)

- `MAX_PLATFORM_DB_CONNECTIONS` is **fleet-wide**, pinned by `db-budget.test.ts`:
  these are direct connections, so `MAX_CONTAINERS` × per-replica pools consumes
  `max_connections` outright, and hitting that ceiling is an outage. It has no
  per-tenant term — keep it that way; a tenant-scaled term cannot be bounded by
  a constant.
- The ceiling is crossed **silently** — no admission control, no load
  shedding. First symptom: `remaining connection slots are reserved` on a
  platform read.
- **Boot checks the claim once** (`db-capacity.ts`: `max_connections` plus a
  `pg_stat_activity` count against `platformDbBudget()`). The reading is a
  FLOOR and never blocks boot; growth after boot (Supabase's own workers, a
  leak in our pools) is unobserved. The budget reads env, and `modal_deploy.py`
  must export `MAX_CONTAINERS` (asserted by `db-budget.test.ts`).
  `MAX_PLATFORM_DB_CONNECTIONS`'s doc has the rest.

## Pool routing: membership is decided by session affinity

Measured against Supavisor in transaction mode, `pg_advisory_lock` loses
exclusion while `pg_try_advisory_xact_lock` inside `begin … commit` stays
correct. `platformDbConnectionsPerReplica` carries this.

- `SUPABASE_DB_URL` — direct, **session** mode. Consumers: the slug-lock pool,
  and the queue sweep's `NOTIFY` listener on its own handle (a subscription on
  a transaction pool receives nothing). The DevKit world also needs session
  mode (graphile-worker named prepared statements, `LISTEN` with no polling
  fallback, session-scoped advisory lock). `assertSessionModeUrl` refuses a
  pooler.
- `PLATFORM_POOLER_URL` — Supavisor **transaction** mode, for the admin pool.
  Refuses a session-mode URL (multiplexes nothing while looking set). Unset
  means the admin pool is direct and the budget understates a replica, so boot
  announces it (`unpooledAdminConnections`).
- Only the slug-lock pool counts in `MAX_PLATFORM_DB_CONNECTIONS`.
  `connection-config.test.ts` pins both routing rules.

## The admin pool bounds guest THROUGHPUT (`_route.ts`)

`ADMIN_POOL_MAX` (16) is also a concurrency limit: every guest-called platform
route runs on a reservation held for the whole request, so it is the number of
guest platform calls a replica may have in flight; the next queues on
`reserve()`. Which routes those are, and that each uses `withReserved` +
`guestSlug` from `_route.ts`, is konsistent's `guest-called-platform-routes`
(every module in `guest-handlers/`). `withReserved` logs the wait and then
`workMs` under one trace id (its doc says why). **Raising it is a fact about the
pooler**: under transaction mode these are cheap client slots; unpooled they
are direct backends and boot warns by name. The slug-lock pool stays direct.

## PlatformEvents (`events.ts`)

Cross-replica change notifications (`watchAgents`, `watchWorkspace`,
`watchChat`, `watchScopeProjects`) are SIGNALS: handlers re-read rows and never
trust payloads. Memory emitter + store decorators in dev/tests;
`realtime-events.ts` in production.

- **A store decorator must wrap EVERY mutator.** Production wraps nothing (the
  row's UPDATE is what Realtime streams), so a missed mutator is invisible there
  and in dev is a write no watcher hears — no polling loop covers it.
- **A test standing in for a real writer has to BE that writer** (call e.g.
  `stampWorkspaceMeta`, not a hand-rolled read-modify-write), or it cannot
  catch a missed decorator.
- **Wait out an emit with `memory.settled()`, never a microtask spin.** A
  watcher whose work must be waitable RETURNS its promise (as
  `watchAgentInvalidation` returns its `withSlugLock` promise). `settled()`
  really waits, so it can deadlock: a test holding the slug lock must commit,
  release, then settle. Its doc comment has the full account.
