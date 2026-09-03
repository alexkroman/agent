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
 *
 * **`gzip-request.ts` carries the rest**: which allocation the 28 KB makes worth
 * attacking, and the synchronous parse stall this bounds the OVERLAP of.
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
 * How long one `/manage/*` request to a guest may take.
 *
 * Shared rather than module-private because two callers now hold the same
 * deadline against the same surface — `warm-harness.ts`'s status/drain pair and
 * `agent-logs.ts`'s log read — and {@link SHUTDOWN_TEARDOWN_TIMEOUT_MS}'s
 * arithmetic below already counts it, which a number defined out of its reach
 * could only agree with by coincidence.
 */
export const MANAGE_REQUEST_TIMEOUT_MS = 5000;

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

// ── Guest harness resolution ─────────────────────────────────────────────────

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
 * Connections the platform admin pool may open per replica.
 *
 * Every statement on it is a short query (Vault, agents rows, workspaces,
 * chats, the sweeps) — the one long-held resource, a slug lock's reserved
 * connection, has its own pool below.
 *
 * ## It was 4, and 4 was a ceiling on GUEST throughput that nothing intended
 *
 * The four guest-called platform routes — the workflow journal, the queue,
 * session state, upload records — each run their work on a RESERVATION from
 * this pool (`_platform-route.ts`'s `withReserved`), held for the whole
 * request. So this number is not merely a connection budget: it is the count
 * of guest platform calls a replica may have in flight AT ALL, and the fifth
 * queues on `reserve()`.
 *
 * That was reached in production. A deployed transcription run sustained ~2
 * `POST /:slug/workflow-journal` a second at ~840 ms of server time each — one
 * run, on a replica that also serves Vault, the agents row every broker call
 * needs, and the sweeps. At 4 slots x ~1.2 calls a second a slot, one busy
 * durable run is most of the replica's control plane.
 *
 * ## Raising it costs the instance nothing, and that is a fact about the pooler
 *
 * `MAX_PLATFORM_DB_CONNECTIONS` deliberately does NOT count this pool, on the
 * premise that it reaches the instance through `PLATFORM_POOLER_URL` in
 * TRANSACTION mode, which really does multiplex — the argument, and the one
 * thing that would break it (session-scoped `pg_advisory_lock`, which lives on
 * the slug pool and stays direct), is in `platformDbConnectionsPerReplica`.
 * Under it a reserved-but-idle client connection pins no server backend, so
 * these are cheap client-side slots rather than `max_connections`.
 *
 * The number that is NOT free is the unpooled one: with `PLATFORM_POOLER_URL`
 * unset every replica opens this many DIRECT session-mode backends, which
 * `unpooledAdminConnections` counts into the budget and boot warns about by
 * name. That warning is what makes raising this safe rather than a landmine —
 * a deployment without a pooler is told, at boot, exactly what it now costs.
 *
 * ## It is the WHOLE PLATFORM's funnel, not one replica's share
 *
 * "Per replica" undersells it twice over. `MIN_CONTAINERS = 1` with
 * `BUFFER_CONTAINERS = 0` (`modal_deploy.py`, which says so in as many words),
 * so the steady state is ONE container — `MAX_CONTAINERS = 3` is a burst
 * ceiling the autoscaler reaches under load, never the operating condition.
 * And a sandbox opens no Postgres connection of its own: the platform
 * provisions no tenant database, so every deployed agent's journal, session
 * state and upload records reach Postgres ONLY through these routes.
 *
 * So this number is not a per-replica share of some larger fleet allowance. It
 * is this many connections, TOTAL, for every deployed agent on the platform,
 * shared with Vault, the agents row every broker call needs, and the sweeps.
 * That is why one transcription run could saturate it at 4.
 *
 * ## Why 16: `WORKFLOW_QUEUE_DELIVER_CONCURRENCY` sets the floor
 *
 * The replica dispatches up to `WORKFLOW_QUEUE_DELIVER_CONCURRENCY` (8) queue
 * deliveries at once and every walking guest posts its journal back here, so a
 * pool under 8 STARVES THE FAN-OUT THIS PROCESS ITSELF STARTED — a deadlock
 * shape rather than a slow one, and a floor the old 4 sat under before
 * counting anything else. 16 is that doubled, the second eight being the live
 * sessions' own guest calls plus the platform's internal reads. Tune it
 * against that constant rather than by feel.
 *
 * **16 is a first step, not a derived ceiling.** With the pooler on these are
 * client-side slots that pin no server backend, and `MAX_INPUTS` lets one
 * container hold 400 concurrent requests — so the honest input for a further
 * raise is Supavisor's own `pool_size`. That is Supabase project config, not
 * readable from this repo and not exposed by the CLI (`supabase config` has
 * only `push`); read it off the dashboard's Connection Pooling settings, or
 * the Management API's `/v1/projects/{ref}/config/database/pooler`. Past it
 * the queueing moves one layer down rather than going away.
 *
 * ## What it costs UNPOOLED, measured
 *
 * An earlier note claimed 16 "keeps the fleet's unpooled worst case inside
 * what the boot capacity check can report", which bounds nothing — the check
 * reports whatever it computes. Measured against the real instance
 * (`supabase inspect db role-stats`, 2026-09-02): `max_connections` **60**,
 * with **16 in use** at rest — 10 `supabase_admin`, 2 `postgres` (ours), 2
 * `authenticator`, 1 `pgbouncer`, 1 CLI. So ~44 free, not the ~30 the older
 * "23-30 Supabase workers" note assumed.
 *
 * Against that baseline, per replica costing
 * `platformDbConnectionsPerReplica()` (10) direct plus this pool when unpooled:
 *
 * - pooled, steady state (1 replica): 10 + 16 = **26 of 60**
 * - pooled, `MAX_CONTAINERS` burst: 30 + 16 = **46 of 60**
 * - UNPOOLED, steady state: 26 + 16 = **42 of 60** — fits
 * - UNPOOLED, burst: 78 + 16 = **94 of 60** — does not
 *
 * So the unpooled configuration is survivable on one container and is an
 * outage on a scale-up, where at 4 it was marginal in both. The boot warning
 * is the thing to act on; `MIN_CONTAINERS = 1` is the only reason it is not
 * already one.
 */
export const ADMIN_POOL_MAX = 16;

/**
 * Connections reserved for per-slug mutation locks. Each concurrent
 * distinct-slug mutation holds one for its whole critical section, so this is
 * the ceiling on concurrent mutations THIS replica can start — past it,
 * acquires queue in the pool, which is indistinguishable to the caller from
 * queueing in Postgres's lock manager.
 */
export const SLUG_LOCK_POOL_MAX = 4;

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
 * paragraph asserted it could not be. Still verify by hand (and leave room for
 * migrations, the dashboard, and Supavisor) when changing either side;
 * `platform-db-budget.test.ts` holds the arithmetic so that raising
 * `MAX_CONTAINERS`, a pool size, or the cluster list fails a check instead of
 * failing in production.
 *
 * **It was 80 against a provisioned instance that has 60**, which is exactly the
 * unchecked claim the paragraph above warns about — the dashboard reports
 * `max_connections` 60 on the `t3a.micro` this runs on, so the "control-plane
 * outage at peak" above was reachable. 30 leaves 30 for what else needs the
 * instance: Supabase's own Realtime / PostgREST / Storage workers (23-30 in use
 * across five measured boots, not the ~17 this once claimed),
 * `supabase db push`, the dashboard, and Supavisor's server side.
 *
 * **Nothing per-tenant is in this number any more, and the admin pool never was.**
 * So what this bounds is `MAX_CONTAINERS x platformDbConnectionsPerReplica()`,
 * which is what `platform-db-budget.test.ts` asserts and what `platformDbBudget()`
 * returns unchanged.
 *
 * It used to carry a second term, an allowance for per-app DATABASES, and the
 * history is worth keeping because it is the argument for why removing them
 * relieved this ceiling rather than merely simplifying it. That term was first
 * excluded on the premise that Supavisor pooled those connections out of
 * `max_connections` accounting. It does not — the pooler the Workflow DevKit
 * requires is SESSION mode, which multiplexes nothing, so one client connection
 * was one real backend. Counting it in was the correction; the stale wording had
 * already cost a bug, `platformDbBudget()` adding the allowance to a constant that
 * contained it, claiming 60 on an instance with 60 and warning on every boot it
 * ever ran.
 *
 * With tenant databases gone the term is not merely uncounted but ABSENT: the
 * platform opens connections for itself alone, so the fleet claim no longer scales
 * with the number of tenants — the one variable this constant could never bound.
 *
 * **And it is the PRODUCT exactly, not a ceiling over it, because
 * `platformDbBudget()` returns this number verbatim.** It sat at 40 against a
 * product of 30 (`MAX_CONTAINERS` 3 x 10 per replica) — the residue of the
 * tenant term, whose removal freed 10 that nobody gave back. Ten connections of
 * claim that no replica can ever open is not conservatism, because the thing
 * reading this is the boot capacity CHECK: production announced
 * `budget OVERRUNS the instance by 17` on an instance whose real overrun was 7,
 * and a warning that overstates by 10 is one nobody can act on. The paragraph
 * above already said this number IS the product; `platform-db-budget.test.ts`
 * asserted only `<=`, which let the two drift, and now asserts EQUALITY — so a
 * pool bump fails a check rather than silently spending headroom that the
 * capacity warning has already promised away.
 *
 * The ADMIN pool stays out, and that one IS a routing decision — see
 * {@link platformDbConnectionsPerReplica}. It reaches the instance through
 * `PLATFORM_POOLER_URL` in TRANSACTION mode, which does multiplex. With either
 * pooler URL unset those connections are DIRECT and this budget understates the
 * fleet, which is why boot announces the reading rather than trusting the constant.
 */
export const MAX_PLATFORM_DB_CONNECTIONS = 30;

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
