// Copyright 2025 the AAI authors. MIT license.
// Server-specific constants. SDK-level constants live in aai.

import { createRequire } from "node:module";

/** 64 KB. */
export const MAX_ENV_SIZE = 65_536;

/**
 * Parse a millisecond env override where `0` is meaningful (so `|| default`
 * would swallow it): unset/empty or unparseable falls back to `fallback`,
 * an explicit non-negative number — including 0 — is honored. Without the
 * finite check, `SANDBOX_RETIRE_DRAIN_MS="10m"` becomes NaN, every
 * comparison against the deadline is false, and the drain window silently
 * collapses to zero — cutting live calls on every redeploy, which is the
 * exact failure the window exists to prevent.
 */
export function envMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

/** A positive-integer env override (a count, not a duration) — {@link envMs}'s companion. */
export function envCount(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

export const DEFAULT_PORT = 8080;

/**
 * 30 MB. Workers ship their own SDK runtime + provider SDKs (the CLI
 * wrapper's `__aaiCreateRuntime` — see worker-bundler.ts), which is ~8 MB
 * minified before any user code; the cap bounds user code + assets on top.
 */
export const MAX_WORKER_SIZE = 30_000_000;

/**
 * How many deploy bodies may be buffered and parsed AT ONCE.
 *
 * `MAX_INFLATED_BODY_BYTES` bounds one request; nothing bounded how many
 * arrive together, so peak memory was a function of arrival rate — a number
 * the caller picks, not the server. Measured against the real orchestrator, a
 * single max-size deploy costs ~164 MB of RSS (the compressed buffer, the
 * inflated buffer, the re-wrapped body, then `JSON.parse`'s UTF-16 string and
 * object), from **28 KB on the wire** because the worker gzips ~1000:1 when
 * it is compressible. Six concurrent cost ~388 MB against a container
 * provisioned at 2048 MiB.
 *
 * 2 keeps the worst case near ~330 MB while leaving deploys able to overlap.
 * It is low because it can afford to be: a deploy is a rare, human-initiated
 * operation, not a request-path one, and the queue below absorbs bursts. Note
 * the cap is what makes the SIZE limit survivable, so the two move together
 * — raising `MAX_WORKER_SIZE` (bundles do grow) means re-checking this.
 * Override with `DEPLOY_BODY_CONCURRENCY`.
 */
export const DEPLOY_BODY_CONCURRENCY = envCount(process.env.DEPLOY_BODY_CONCURRENCY, 2);

/**
 * How long a deploy waits for one of those slots before answering 503.
 *
 * A waiter holds only its unread request stream — none of the buffers above —
 * so queueing is cheap and this can be generous relative to the ~1s a deploy
 * body takes to inflate and parse. Bounded anyway: an unbounded queue trades
 * the memory problem for a latency problem and keeps every socket open while
 * it does. `Retry-After` rides the 503, and the CLI already retries them.
 * Override with `DEPLOY_BODY_WAIT_MS`.
 */
export const DEPLOY_BODY_WAIT_MS = envMs(process.env.DEPLOY_BODY_WAIT_MS, 15_000);

/**
 * How long a sandbox superseded by a deploy/secret/storage mutation keeps
 * serving the sessions it already had, before its remaining calls are cut.
 *
 * A mutation does not end the conversations in flight on the old sandbox, so
 * terminating it on the spot cuts every one of them mid-word.
 * Retirement detaches the sandbox from its slot
 * (the broker is the only routing point, so no NEW session can land on it)
 * and lets the old ones finish on the old code, which is what a client
 * already assumes for the duration of a call.
 *
 * Bounded, because a retired sandbox is a billed guest still running
 * superseded code: past the deadline the deploy wins and the stragglers are
 * closed. 10 minutes sits above a normal call and above session-core's own
 * 5-minute `idleTimeoutMs` (so an abandoned session self-reaps well inside
 * it) without letting one long call pin an old bundle indefinitely.
 * Override with `SANDBOX_RETIRE_DRAIN_MS`; 0 restores immediate termination.
 */
export const SANDBOX_RETIRE_DRAIN_MS = envMs(process.env.SANDBOX_RETIRE_DRAIN_MS, 600_000);

/**
 * How long a BROKER call waits for a booting sandbox before answering 503.
 *
 * Deliberately far below the boot budget itself (`AGENT_HEALTH_TIMEOUT_MS`,
 * 120s in warm-harness.ts). Those are two different questions that shared
 * one number: how long a guest may take to come up, and how long a CLIENT
 * should be left holding a request while it does. An agent whose top-level
 * code blocks never becomes ready, so every broker call hung for two full
 * minutes before returning the 503 — permanently, and for every caller.
 *
 * Timing out here does NOT cancel the boot: the sandbox is already attached
 * to its slot and reports `alive()` while pending, so it keeps booting and
 * the next call attaches to the SAME readiness promise rather than spawning
 * a second sandbox. The cost of tripping this on a healthy-but-slow boot is
 * therefore one client reconnect, not a failure — `session-core.ts`
 * re-brokers per attempt and only an ANSWERED lookup latches anything.
 *
 * Override with `BROKER_READY_TIMEOUT_MS`; 0 disables the cap and restores
 * waiting for the full boot budget.
 */
export const BROKER_READY_TIMEOUT_MS = envMs(process.env.BROKER_READY_TIMEOUT_MS, 20_000);

/**
 * After sandbox teardown, how long to wait for the HTTP server's remaining
 * connections to close before exiting anyway. By the time this timer arms,
 * guests are already retired, and a straggling connection is not a failed
 * shutdown — so the fallback exits 0.
 */
export const SHUTDOWN_CLOSE_FALLBACK_MS = 3000;

/**
 * How long a TEARDOWN path — `Sandbox.drain`, `Sandbox.shutdown` — waits on a
 * sandbox that has not finished booting.
 *
 * Both go through the spawn's readiness promise, because reaching a guest
 * needs a handle. That promise is bounded by the BOOT budget
 * (`GUEST_READY_TIMEOUT_MS`, 120s), which is the right answer for a broker
 * waiting on a sandbox it is about to serve and the wrong one for a process
 * that is exiting: retirement then blocks for two minutes on a guest that has
 * no sessions to drain, because it has never served one.
 *
 * Bounding it cannot orphan the guest, which is the only reason waiting was
 * ever justified. An agent-mode guest owns its own idleness and self-exits
 * after `AGENT_IDLE_EXIT_MS` with zero sessions (see
 * `packages/aai-guest/CLAUDE.md`), and Modal's `idleTimeoutMs`/`timeoutMs` sit
 * behind that — so a boot we walk away from is reclaimed on the guest's clock.
 * Waiting out the full budget does not reclaim it any better; it just spends
 * the container's stop grace, and a SIGKILL orphans the guest anyway while
 * cutting every teardown that would otherwise have finished.
 *
 * **That argument is about RECLAIM, and it was read as though it were about
 * running.** So lapsing here no longer means giving up: `Sandbox.shutdown`
 * terminates the sandbox outright (`BackendAgentSpawn.onSpawned`), and this
 * bound decides only how long a GRACEFUL drain is waited for. Read the `28P01`
 * note on `Sandbox.shutdown` for the delete that made it necessary.
 *
 * Five seconds, so a boot that is nearly done is still drained.
 * Override with `SANDBOX_TEARDOWN_READY_MS`. Unlike the two constants above,
 * 0 is NOT a distinct behaviour here — it is clamped to 1ms at the call site,
 * since giving up on a pending boot is what any small value already does.
 */
export const SANDBOX_TEARDOWN_READY_MS = envMs(process.env.SANDBOX_TEARDOWN_READY_MS, 5000);

/**
 * The whole service teardown's deadline — the general net under
 * {@link SANDBOX_TEARDOWN_READY_MS}'s specific one.
 *
 * `createShutdownHandler` awaits `onShutdown()` before arming any timer, so
 * for a long time the one bound on shutdown protected the fast half (waiting
 * for connections to close) and not the slow half (retiring every resident
 * guest). The bounded work in there now adds up to
 * `SHUTDOWN_GRACE_MS` (3s) + {@link SANDBOX_TEARDOWN_READY_MS} (5s) +
 * `MANAGE_REQUEST_TIMEOUT_MS` (5s) = 13s, run in PARALLEL across guests — but
 * the Modal control-plane calls underneath (`sandbox.terminate()`) carry no
 * timeout of their own, so the sum is a floor rather than a bound. This is
 * what makes it one.
 *
 * 20s leaves margin over that 13s; with {@link SHUTDOWN_CLOSE_FALLBACK_MS}
 * after it the process exits within ~23s of the signal, which must stay inside
 * the platform's container stop grace — Modal SIGKILLs at the end of it, and a
 * SIGKILL is the failure this whole ordering exists to avoid (see
 * live-streams.ts). Raising `SHUTDOWN_GRACE_MS` means raising this too.
 * Override with `SHUTDOWN_TEARDOWN_TIMEOUT_MS`; 0 disables the net.
 */
export const SHUTDOWN_TEARDOWN_TIMEOUT_MS = envMs(process.env.SHUTDOWN_TEARDOWN_TIMEOUT_MS, 20_000);

// ── Durable-workflow wake sweep (workflow-wake.ts) ───────────────────────────

/**
 * How often the replica looks for durable-run work that has come due.
 *
 * This is the whole latency budget of a wake: a run sleeping until 09:00 resumes
 * at 09:00 plus up to one interval plus a boot. A minute is far below anything a
 * `sleep()`-scale workflow cares about and keeps the sweep's cost — one catalog
 * query plus one read per workflow-using app, on ONE replica (the pass is
 * leader-elected) — negligible.
 *
 * Override with `WORKFLOW_WAKE_INTERVAL_MS`; **0 disables the sweep entirely**,
 * which is the honest kill switch: nothing else in the platform boots a sandbox
 * for a parked run, so turning this off means durable runs advance only when
 * something else happens to wake the agent.
 */
export const WORKFLOW_WAKE_INTERVAL_MS = envMs(process.env.WORKFLOW_WAKE_INTERVAL_MS, 60_000);

/**
 * How long the sweep leaves a slug alone after waking it.
 *
 * The bound on a wake LOOP, which is the one way this sweep could cost real
 * money: the hint is written by the guest after each queue callback, so a guest
 * that boots and cannot run its world (a world that fails to start, a bundle
 * whose workflows throw at load) never rewrites it and stays due forever.
 * Without a backoff that is a sandbox per interval, indefinitely.
 *
 * Ten minutes is twice `AGENT_IDLE_EXIT_MS`, so a woken guest that had nothing
 * to do has already self-exited before its slug is eligible again — the retry
 * costs one boot per ten minutes rather than one per minute, and a run that
 * really was resumed rewrites the hint long before then. Override with
 * `WORKFLOW_WAKE_RETRY_MS`.
 */
export const WORKFLOW_WAKE_RETRY_MS = envMs(process.env.WORKFLOW_WAKE_RETRY_MS, 600_000);

/**
 * How long the sweep's own statements may run.
 *
 * The hint table lives in the TENANT's schema and the tenant's role owns it (see
 * `aai/host/workflow-wake-hint.ts`), so its size is not the platform's to
 * control: a tenant that grows it turns the platform's `min(wake_at)` into a
 * scan. Set on the sweep's reserved connection inside a transaction (`set
 * local`), so it cannot leak onto a pooled connection the way a bare `set`
 * would, and so one tenant's read failing is one tenant's wake lost rather than
 * the whole pass. Override with `WORKFLOW_WAKE_READ_TIMEOUT_MS`.
 */
export const WORKFLOW_WAKE_READ_TIMEOUT_MS = envMs(process.env.WORKFLOW_WAKE_READ_TIMEOUT_MS, 5000);

/**
 * How long a wake waits for the sandbox it just asked for.
 *
 * The sweep is not a client: nothing is holding a request open for the answer,
 * and it only needs the boot STARTED — the next tick's hint read is what says
 * whether the run advanced. So it does NOT inherit
 * {@link BROKER_READY_TIMEOUT_MS} (20s), which a tick with
 * {@link WORKFLOW_WAKE_MAX_PER_TICK} cold slugs would spend minutes of, serially,
 * overrunning its own interval. Long enough that a LIVE resident (URL already
 * resolved) still answers `ok`, short enough to be free; timing out cancels
 * nothing, since the sandbox is attached to its slot and keeps booting.
 * Override with `WORKFLOW_WAKE_READY_MS`; 0 restores waiting for the whole boot.
 */
export const WORKFLOW_WAKE_READY_MS = envMs(process.env.WORKFLOW_WAKE_READY_MS, 500);

/**
 * How many sandboxes one sweep tick may boot.
 *
 * Bounds the burst, not the work: anything over the cap is due on the next tick
 * (ordering is by slug, so the cap cannot starve one agent forever — a woken
 * slug enters its backoff and yields its place). Sized above any plausible
 * simultaneous-due count and below the point where a tick would spawn faster
 * than Modal schedules. Override with `WORKFLOW_WAKE_MAX_PER_TICK`.
 */
export const WORKFLOW_WAKE_MAX_PER_TICK = envCount(process.env.WORKFLOW_WAKE_MAX_PER_TICK, 10);

/**
 * How long `/:slug/workflows/*` may go WITHOUT PROGRESS before giving up.
 *
 * An INACTIVITY deadline, not a total: two routes on the surface are
 * legitimately unbounded in opposite directions — `GET /runs/:id/events` holds
 * a stream open for minutes, and `POST /workflows/uploads` carries up to
 * `MAX_WORKFLOW_UPLOAD_BYTES` — so the forward is `bound: "activity"`, whose
 * doc in `guest-forward.ts` carries the argument and the 500 MB upload this
 * number used to abort at 30.3s.
 *
 * 30s rather than something tighter because the first request through this route
 * is what BOOTS the sandbox: the broker has already waited for readiness, but a
 * cold guest's first HTTP answer still lands behind module loading. Override
 * with `WORKFLOW_PROXY_TIMEOUT_MS`.
 */
export const WORKFLOW_PROXY_TIMEOUT_MS = envMs(process.env.WORKFLOW_PROXY_TIMEOUT_MS, 30_000);

/**
 * Locate the built Node guest harness — the `aai-guest` workspace package's
 * single-file artifact (overridable via GUEST_HARNESS_PATH). Resolved
 * lazily at sandbox creation, so a missing build fails the spawn loudly
 * rather than the server boot.
 */
export function resolveHarnessPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GUEST_HARNESS_PATH) return env.GUEST_HARNESS_PATH;
  try {
    return createRequire(import.meta.url).resolve("aai-guest/harness");
  } catch (err) {
    throw new Error(
      "Guest harness not built — run `pnpm --filter aai-guest build` " +
        "(or set GUEST_HARNESS_PATH to a built harness.mjs)",
      { cause: err },
    );
  }
}

// ── Platform database connection budget ──────────────────────────────────────
//
// Here rather than in service-config.ts (which consumes them) for two reasons:
// they are POLICY, not composition, and service-config is the composition root
// — a 489-line module nothing else can cheaply import. A test that reached for
// these through it pulled the whole root into the v8 coverage denominator,
// which reports only files it loaded, and dropped the package 3.7 points on
// its own.

/**
 * Connections the platform admin pool may open per replica. Every statement
 * on it is a short query (Vault, agents rows, workspaces, chats, the sweeps)
 * — the one long-held resource, a slug lock's reserved connection, has its
 * own pool below.
 */
export const ADMIN_POOL_MAX = 4;

/**
 * Connections reserved for per-slug mutation locks. Each concurrent
 * distinct-slug mutation holds one for its whole critical section, so this is
 * the ceiling on concurrent mutations THIS replica can start — past it,
 * acquires queue in the pool, which is indistinguishable to the caller from
 * queueing in Postgres's lock manager.
 */
export const SLUG_LOCK_POOL_MAX = 4;

/** Connections one extra `APP_DB_URLS` placement cluster pools per replica. */
export const APP_DB_TARGET_POOL_MAX = 4;

/**
 * Connections one SHORT-LIVED connection into a single app's own database opens.
 *
 * One, and the number is the whole point. Per-app databases mean the admin pool
 * cannot reach a tenant's tables — a Postgres connection is bound to one
 * database — so the platform opens a connection per app database for
 * provisioning's in-database steps, the usage read, and the wake-hint read.
 * Retaining a pool per app would make the fleet's connection count a function of
 * the number of APPS, which is the one variable `MAX_PLATFORM_DB_CONNECTIONS`
 * cannot bound. These are opened, used, and closed.
 *
 * The concurrency bound therefore lives at the CALLER: the wake sweep reads at
 * most `WORKFLOW_WAKE_MAX_PER_TICK` app databases per tick, and provisioning is
 * serialized per slug by the mutation lock. That is why this does not appear in
 * `platformDbConnectionsPerReplica` — it is a transient, bounded by a policy
 * above it, not a resident pool.
 */
export const APP_DB_ADMIN_POOL_MAX = 1;

/**
 * The platform's own ceiling on DIRECT Postgres connections, fleet-wide.
 *
 * These are session-mode connections by construction — `assertSessionModeUrl`
 * refuses a transaction-mode pooler, because an advisory lock needs connection
 * affinity to mean anything (platform-lock.ts). So they consume the database's
 * `max_connections` directly, with no Supavisor in front to multiplex them,
 * and the fleet total is `MAX_CONTAINERS × per-replica` — a number that lived
 * in two files that never referred to each other.
 *
 * The failure at the ceiling is not degradation. Pools open LAZILY, so the
 * limit is only reached under load, and what happens there is that every
 * platform read starts failing at once with "remaining connection slots are
 * reserved": Vault, the agents row the broker needs, workspaces, chats. A
 * control-plane outage, at peak, with nothing before it to read as a warning.
 *
 * **This number is a claim about the provisioned instance, and boot now CHECKS
 * it** (`platform-db-capacity.ts`): the server holds a connection, so
 * `show max_connections` and a `pg_stat_activity` count are one query each, and
 * a budget that promises more than the instance can give says so at boot
 * instead of at peak. It went unchecked for as long as it did because this
 * paragraph asserted it could not be — the check is the cheaper half of the
 * verification it asked for. Still verify by hand (and leave room for
 * migrations, the dashboard, and Supavisor) when changing either side. `platform-db-budget.test.ts` holds the arithmetic so that
 * raising `MAX_CONTAINERS`, a pool size, or the cluster list fails a check
 * instead of failing in production. The tenant-facing half of this concern was
 * always reasoned explicitly (`APP_DB_CONNECTION_LIMIT`, "so one hot app
 * cannot starve the shared cluster"); the platform's own half was not.
 *
 * **It was 80 against a provisioned instance that has 60**, which is exactly the
 * unchecked claim the paragraph above warns about — the dashboard reports
 * `max_connections` 60 on the `t3a.micro` this runs on, so the fleet ceiling
 * promised more than the database could give and the "control-plane outage at
 * peak" above was reachable. 40 leaves 20 for what else needs the instance:
 * Supabase's own Realtime / PostgREST / Storage workers (~17 in use at idle),
 * `supabase db push`, the dashboard, and Supavisor's server-side connections.
 *
 * **Neither per-app databases NOR the admin pool are in this number, and both
 * are routing decisions rather than omissions** — see
 * {@link platformDbConnectionsPerReplica} for what may be pooled and why the slug
 * lock may not. They are reached through Supavisor in SESSION mode
 * (`APP_DB_POOLER_URL`, applied by `withPoolerHost` in app-database.ts), so they
 * consume pooler capacity rather than `max_connections` — which is what makes
 * them boundable at all, since a direct connection per app scales with the number
 * of APPS and no fleet-wide ceiling can bound that. Their governing limits are
 * Supavisor's instead: a pool per `user+db+mode` triple, each entitled to the
 * configured pool size, against a default `max_pools` of 50 per tenant. With
 * `APP_DB_POOLER_URL` unset the connections are DIRECT and this budget
 * understates the fleet by one per replica, which is why boot announces it.
 */
export const MAX_PLATFORM_DB_CONNECTIONS = 40;

/**
 * The per-tenant connection ceiling, so one hot app cannot starve the shared
 * instance. It lives here rather than beside the DDL that applies it because
 * it is a TERM IN THE BUDGET (see MAX_ACTIVE_APP_DATABASES), and the budget's
 * arithmetic is checked by a unit test that must not import a composition
 * root to reach it.
 *
 * **10, and the number is a SUM a workflow guest really needs**, not a round
 * figure. It was 4, sized when `ctx.db` was the only thing that ever used the
 * role — which was true only because the Workflow DevKit could not connect at all
 * under the per-schema model. Now that it can, one guest holds:
 *
 * | what | how many |
 * | --- | --- |
 * | the DevKit's world pool (`WORKFLOW_POSTGRES_MAX_POOL_SIZE`) | 4 |
 * | its dedicated `LISTEN` client, outside that pool | 1 |
 * | `ctx.db`'s own pool (`APP_DB_POOL_MAX`) | 4 |
 * | one spare, for the world's migration on boot | 1 |
 *
 * At 4 the symptom was every workflow request failing `too many connections for
 * role "app_…"`. The two sides are pinned against each other on purpose —
 * `aai/host/workflow-world.ts` sets the DevKit's half and carries the same table
 * — so raising one without the other reintroduces exactly that error.
 */
export const APP_DB_CONNECTION_LIMIT = 10;

/**
 * How many app databases the budget assumes are CONCURRENTLY ACTIVE.
 *
 * The one term {@link MAX_PLATFORM_DB_CONNECTIONS} left uncounted, and it was
 * uncounted on a premise that does not hold. `platform-db-budget.test.ts`
 * excluded per-app connections because they are POOLED — but the pooler they go
 * through is Supavisor in SESSION mode, which is mandatory for the Workflow
 * DevKit (see `withPoolerHost` in app-db-url.ts) and which multiplexes NOTHING.
 * One client connection is one real backend. So routing them through Supavisor
 * moves them out of `max_connections` accounting without moving them out of
 * `max_connections`, and the budget was a bound on the term that does not grow
 * while ignoring the term that scales with tenants.
 *
 * Measured against a real provisioned app: one workflow guest holds **6**
 * backends at rest (4 for the DevKit's world pool, 2 for `ctx.db`) and is
 * ENTITLED to {@link APP_DB_CONNECTION_LIMIT}, which is what this budgets
 * against — a ceiling has to assume the ceiling.
 *
 * **2 is honest arithmetic, not a target, and it is the finding.** With
 * `MAX_CONTAINERS = 5` the platform's own direct pools take 20 of the 40, which
 * leaves room for two apps at their entitlement. That is too few, and no
 * further code change can raise it: the instance is the constraint (the
 * provisioned `max_connections` is 60, against ~17 for Supabase's own workers).
 * Raising this needs either a bigger instance or `APP_DB_URLS` cellular
 * sharding, which is the only fix that breaks the coupling between tenant count
 * and one instance's ceiling. Until then the number is small ON PURPOSE, so
 * that the test fails when growth outruns the provisioning.
 */
export const MAX_ACTIVE_APP_DATABASES = 2;

/**
 * Concurrent live SSE streams one caller SCOPE may hold across this replica.
 *
 * `GET /studio/events` and `GET /studio/projects/:project/events` were capped
 * by nothing and metered by nothing: `live-streams.ts` computed `live.size` and
 * gated on it nowhere, and the studio's rate limiters cover chat,
 * project-create and preview-wake only. One caller could hold as many streams
 * as it had sockets.
 *
 * A CAP rather than a rate limit, and the distinction is the point: a stream is
 * a concurrent resource, so the thing worth bounding is how many are held at
 * once. A fixed-window limiter meters ARRIVALS, which would punish exactly the
 * honest client this is meant to protect — every tab reconnects at once after a
 * deploy or a scale-in (`endLiveStreams`), so a window sized for steady state
 * refuses the reconnect storm that the system itself caused.
 *
 * 50 is far above legitimate use — a tab holds at most two (the scope list plus
 * one project) — and far below the point where streams matter to a replica: at
 * the measured ~100 KB each, this whole cap is ~5 MB, and one replica held
 * 2,000 streams with no measurable degradation. It bounds the blast radius of a
 * single abusive scope without being reachable by a person with many tabs open.
 */
export const MAX_LIVE_STREAMS_PER_SCOPE = 50;

/**
 * DIRECT connections one replica may open, given `extraAppDbTargets` extra
 * placement clusters.
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
export function platformDbConnectionsPerReplica(extraAppDbTargets = 0): number {
  return SLUG_LOCK_POOL_MAX + extraAppDbTargets * APP_DB_TARGET_POOL_MAX;
}
