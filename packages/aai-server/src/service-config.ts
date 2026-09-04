// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared service configuration for the platform's deployable entries — the
 * agent service (this package's index.ts) and the studio/combined entries
 * (the aai-studio-server package). One implementation of "read the
 * environment, build the platform bindings" so the services cannot drift on
 * storage, Vault, locks, or change-stream wiring.
 */

import { randomUUID } from "node:crypto";
import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { type CloseableDb, createPostgresDb } from "@alexkroman1/aai-runtime";
import {
  assertServiceRoleKey,
  hasPlatformDb,
  isLocalDev,
  PLATFORM_TIER_ENV,
  requireEnv,
} from "./_boot.ts";
import { type AgentRows, createMemoryAgentRows, createPgAgentRows } from "./agent-store.ts";
import { createApiKeyVerifierFromEnv } from "./api-key-verify.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore, createPgChatStore } from "./chat-store.ts";
import { ADMIN_POOL_MAX, SLUG_LOCK_POOL_MAX } from "./constants.ts";
import { assertGuestTokenSecret } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import { createModalSandboxDirectory } from "./modal-sandbox-directory.ts";
import type { OrchestratorOpts } from "./orchestrator.ts";
import { platformCronJobs, schedulePlatformSweeps } from "./pg-cron.ts";
import { announceDirectDbHost, platformPoolerUrl } from "./platform-connection-config.ts";
import { announcePlatformDbCapacity } from "./platform-db-capacity.ts";
import {
  PLATFORM_DB_CONNECT_TIMEOUT_SECONDS,
  PLATFORM_DB_QUERY_TIMEOUT_MS,
  PLATFORM_DB_RESERVE_TIMEOUT_MS,
  platformDb,
} from "./platform-db-errors.ts";
import { QUEUE_NOTIFY_LISTEN } from "./platform-db-limits.ts";
import {
  createMemoryPlatformEvents,
  type PlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform-events.ts";
import {
  type AdminDb,
  assertSessionModeUrl,
  createPgSlugLock,
  localSlugLock,
  type SlugMutationLock,
} from "./platform-lock.ts";
import { buildStorage, buildUploadBytes } from "./platform-storage-config.ts";
import { createRealtimePlatformEvents } from "./realtime-events.ts";
import { resolveSandboxBackend } from "./sandbox-backend.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import {
  createMemorySecretStore,
  createVaultSecretStore,
  PLATFORM_STORAGE_KEY_SECRET,
  type SecretStore,
  type SqlExec,
} from "./secret-store.ts";
import { createStudioAuthFromEnv } from "./supabase-auth.ts";
import {
  createMemoryWorkspaceStore,
  createPgWorkspaceStore,
  type WorkspaceStore,
} from "./workspace-store.ts";

const log = createLogger("service");

// Re-exported for the studio entry, which calls it at boot; `buildStorage` is
// NOT re-exported — this module is its only caller, and the studio reaches the
// rest of storage wiring through `buildServiceConfig`.
export { assertStorageBucket } from "./platform-storage-config.ts";

/** buildOpts plus what service entries need beyond the orchestrator's opts. */
export type ServiceConfig = OrchestratorOpts & {
  /**
   * Studio project workspaces and chat histories. Built here because this is
   * the one place that wires the platform database, but deliberately NOT part
   * of `OrchestratorOpts`/`HonoEnv` — only the studio service reads them, and
   * it injects them through its own `StudioHonoEnv` bindings.
   */
  workspaces: WorkspaceStore;
  chats: ChatStore;
  /**
   * Cross-replica change notifications: Supabase Realtime in production,
   * an in-process emitter paired with the memory stores in dev/tests. The
   * entries wire it into sandbox invalidation (`watchAgentInvalidation`)
   * and the studio app's preview SSE route.
   */
  events: PlatformEvents;
  /**
   * The platform admin SQL executor when a platform database is configured
   * and this is not local dev — the studio entry builds its Postgres rate
   * limiters on it. Absent means "use in-memory equivalents".
   */
  sql?: SqlExec;
  /**
   * This process's identity in the cross-replica registries. Stable for the
   * life of the container and unique across them — the studio session
   * registry excludes the caller's OWN rows from its peer lookup, so two
   * replicas sharing an id would each hide the other's sandbox and the
   * duplicate spawns would come straight back. (The AGENT side needs no
   * identity: a sandbox NAME answers "does this exist", not "who made it".)
   */
  replicaId: string;
};

/**
 * Memory stores + the in-process event emitter, paired so a write and its
 * change notification cannot drift — the dev/test equivalent of Postgres
 * rows streaming through Supabase Realtime.
 */
function buildMemoryStores(): {
  agents: AgentRows;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  events: PlatformEvents;
} {
  const memory = createMemoryPlatformEvents();
  return {
    agents: withAgentEvents(createMemoryAgentRows(), memory.emitAgent),
    workspaces: withWorkspaceEvents(createMemoryWorkspaceStore(), memory.emitWorkspace),
    chats: withChatEvents(createMemoryChatStore(), memory.emitChat),
    events: memory.events,
  };
}

/**
 * Boot-time database housekeeping for production: scheduling the pg_cron
 * janitorial sweeps. Loud on failure, but deliberately not fatal — a missing
 * sweep degrades to table growth, which is not worth refusing to serve
 * traffic over.
 *
 * This used to also create the platform tables, the Realtime publication, and
 * the `service_role` grants. All of that is declared in
 * `supabase/migrations/*_platform_schema.sql` now and applied before any code
 * runs; only the SCHEDULING stays here, because the sweep bodies are defined
 * in TypeScript (pg-cron.ts) and change with the code that owns them.
 */
function bootstrapPlatformDb(sql: SqlExec, env: NodeJS.ProcessEnv): void {
  // The blob GC sweep deletes through the Storage API from inside Postgres,
  // so it needs a credential no SQL-only job can otherwise hold. Stored in
  // Vault rather than interpolated into the job command, where it would sit
  // as plaintext in `cron.job` (see PLATFORM_STORAGE_KEY_SECRET). Re-written
  // on every boot so a rotated key reaches the sweep with the next deploy;
  // concurrent replicas booting together are safe because `put` absorbs the
  // create race.
  const url = env.SUPABASE_URL;
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const storage = url && bucket && key ? { url, bucket } : undefined;

  const bootstrap = async (): Promise<void> => {
    const vault = createVaultSecretStore(sql);
    if (storage && key) await vault.put(PLATFORM_STORAGE_KEY_SECRET, key);
    await schedulePlatformSweeps(sql, platformCronJobs({ ...omitUndefined({ storage }) }));
  };
  bootstrap().catch((err: unknown) => {
    log.error("pg_cron sweeps not scheduled — janitorial sweeps will not run", {
      error: errorMessage(err),
    });
  });
}

/**
 * Platform Postgres surface: Supabase Vault for secrets, studio workspaces, the
 * durable-workflow world, session state, and the Realtime change streams — all over
 * `SUPABASE_DB_URL` (service-role connection string) plus `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` for the Realtime socket.
 *
 * **`SUPABASE_DB_URL` decides the whole tier, and there are exactly two.** Set,
 * every store here is Supabase's and the companions are REQUIRED; unset, every
 * store is memory and nothing survives a restart. See {@link hasPlatformDb} for
 * why a MIXTURE is gone rather than merely discouraged — the third state was
 * memory stores beside real per-app databases, and the same failure is now
 * reachable through the workflow world and session state.
 */
export function buildPlatformDb(env: NodeJS.ProcessEnv): {
  secrets: SecretStore;
  /** The agents table (deploy records). Postgres with a platform db, else memory. */
  agents: AgentRows;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  /** Change notifications — see ServiceConfig.events. */
  events: PlatformEvents;
  /** Cross-replica slug mutation lock; in-process without a platform db. */
  slugLock: SlugMutationLock;
  /** Platform admin SQL executor, with a platform db — see ServiceConfig.sql. */
  sql?: SqlExec;
  /**
   * The platform's own coordination slice: a RESERVED connection, and a `NOTIFY`
   * subscription. TWO handles behind one object, because its two members want
   * OPPOSITE things from a connection and only one of them may be pooled.
   *
   * `reserve` is the ADMIN pool, which may be transaction-pooled: the queue
   * sweep reserves per STATEMENT (a delivery must not hold a connection across
   * an HTTP call into a guest) and each guest-called platform route holds one
   * for the life of its request — both wanting a connection nobody else uses
   * WHILE they use it, which is exactly what a transaction pooler pins.
   * `listen` cannot live there and takes its own session-mode handle.
   *
   * This doc used to name the sweep's `LISTEN` and its claim/ack pair together
   * as two things that "must run on one connection". Neither half held: those
   * two must run on DIFFERENT connections, and the claim and the ack are
   * separate reservations by design.
   */
  adminDb?: AdminDb;
} {
  const url = env.SUPABASE_DB_URL;
  if (!url) {
    log.info(
      "no SUPABASE_DB_URL: in-memory secret/agents/workspace/chat stores, no per-app " +
        "databases — DEPLOYED AGENTS ARE LOST ON RESTART. `supabase start` for the durable tier.",
    );
    return {
      secrets: createMemorySecretStore(),
      ...buildMemoryStores(),
      slugLock: localSlugLock,
    };
  }
  // Session mode, not a transaction-mode pooler: the per-slug mutation lock
  // is a Postgres advisory lock, which needs connection affinity to mean
  // anything (see platform-lock.ts). Checked before the pool is built so the
  // failure names the setting rather than surfacing as lost exclusion later.
  // Asserted on every tier, local included: the local stack's 54322 is a direct
  // session-mode port, and a `[db.pooler]` port pasted here is exactly the
  // silent loss of exclusion this refuses — nothing about it is safer on a
  // laptop.
  assertSessionModeUrl(url);
  // The pools live for the process; connections drain when the process exits
  // (no explicit close() hook on the shutdown path today), and postgres.js
  // opens them lazily, so an idle replica pays for none of this.
  //
  // The ADMIN pool goes through Supavisor when one is configured, which is what
  // keeps `ADMIN_POOL_MAX x MAX_CONTAINERS` out of the instance's
  // `max_connections` (see `platformDbConnectionsPerReplica` for the measurement
  // that says it may be pooled and the one lock that may not). Unset, it is
  // direct and the budget understates a replica — announced below rather than
  // left quietly wrong.
  // Before the pools open, so the reason a capacity read is about to fail with
  // ENOTFOUND is the line ABOVE it rather than something to work out afterwards.
  announceDirectDbHost(env);
  const poolerUrl = platformPoolerUrl(env);
  if (poolerUrl === undefined) {
    log.warn(
      "no PLATFORM_POOLER_URL: the admin pool is opening DIRECT connections, so this " +
        `replica costs ${ADMIN_POOL_MAX} more of the instance's max_connections than ` +
        "MAX_PLATFORM_DB_CONNECTIONS accounts for. Set it to Supavisor's " +
        "TRANSACTION-mode URL (port 6543).",
    );
  }
  // `platformDb` wraps the pool so a REACHABILITY failure arrives typed — the
  // HTTP surface answers 503 rather than logging `unhandled error` and returning
  // an opaque 500 (see platform-db-errors.ts for the production outage that
  // shape produced). Applied at the pool because every platform read crosses
  // it; a classification per route is a classification per route to forget.
  const admin = platformDb(
    createPostgresDb({
      url: poolerUrl ?? url,
      max: ADMIN_POOL_MAX,
      connectTimeoutSeconds: PLATFORM_DB_CONNECT_TIMEOUT_SECONDS,
      queryTimeoutMs: PLATFORM_DB_QUERY_TIMEOUT_MS,
      // The RESERVED path takes the same deadline, and this pool is the reason
      // that option exists. Every guest platform route — the workflow journal,
      // the queue, session state, upload records — runs its work on a
      // reservation from HERE (`_platform-route.ts`'s `withReserved`) and takes
      // no advisory lock, so the exemption `reserve()` grants by default left
      // them unbounded: on a silent partition, ADMIN_POOL_MAX hung reads is
      // every other platform read on this replica — Vault, the agents row the
      // broker needs, the rate limits — queued behind them, and each 503s on
      // its own client-side deadline. That took FOUR concurrent watchers when
      // this pool was 4; the shape is unchanged at 16 (see ADMIN_POOL_MAX).
      reservedQueryTimeoutMs: PLATFORM_DB_QUERY_TIMEOUT_MS,
      // And the ACQUIRE, which those two do not cover: a statement's deadline
      // starts once a connection is in hand, so a request that never got one
      // was bounded by nothing on this side. A pool's worth of hung reads is the
      // same arithmetic as the line above, one step earlier — every further
      // platform request queues on `reserve()` with no deadline, and each fails
      // on its CALLER's timeout instead, which is a 500 where this is a 503.
      reserveTimeoutMs: PLATFORM_DB_RESERVE_TIMEOUT_MS,
    }),
  );
  // The queue sweep's `NOTIFY` subscription gets its OWN handle, on the
  // SESSION-mode `url` — never `poolerUrl`. A subscription IS session state and
  // a transaction pooler returns the backend after every statement, so it
  // cannot hold one; opened on the admin pool it established without error and
  // received nothing, and the only symptom was every step-to-step hop paying
  // the poll interval again. `QUEUE_NOTIFY_LISTEN` (`platform-db-limits.ts`)
  // carries that account and what the handle costs.
  //
  // LAZY and memoized: postgres.js connects on first use, so this costs nothing
  // until something listens and `buildPlatformDb` still constructs exactly two
  // POOLS. Deliberately NOT wrapped in `platformDb`, which passes `listen`
  // through unclassified on purpose — a `LISTEN` has no request behind it to
  // answer 503, so wrapping would put a request-shaped taxonomy over a `query`
  // this handle never issues. Nothing closes it, exactly as nothing closes the
  // pools above: one handle per process, holding the one backend the budget
  // already counts.
  let listenerDb: CloseableDb | undefined;
  const queueListener = (): CloseableDb => {
    listenerDb ??= createPostgresDb({
      url,
      // One connection is the whole handle, and the budget term says so. No
      // `idleTimeoutSeconds`: postgres.js opens the listening connection
      // OUTSIDE this pool with its own `max: 1, idle_timeout: null`, so the
      // driver already pins the lifetime of the only connection that exists and
      // a value here would be dead config. `max` still bounds the accident — a
      // stray `query` on this handle must not cost the budget four backends.
      // Measured on PG 16.13: constructing this opens NO backend, `listen()`
      // opens exactly one, and a query on the same handle opens a SECOND.
      max: QUEUE_NOTIFY_LISTEN,
      // The listening connection copies these options, and nothing about
      // ESTABLISHING one is unbounded by nature.
      connectTimeoutSeconds: PLATFORM_DB_CONNECT_TIMEOUT_SECONDS,
    });
    return listenerDb;
  };

  const exec: SqlExec = (query, params) => admin.query(query, params);
  // Change notifications ride Supabase Realtime — the Postgres rows are the
  // emitters (postgres_changes), so unlike the memory path the stores need no
  // write-side wrapping. Required rather than optional: a platform database with
  // no Realtime credential is a server that never invalidates a resident sandbox
  // on redeploy and never pushes studio SSE, and BOTH of those failures are
  // silent (see realtime-events.ts on the channel that rejoins forever).
  // ONE list, in `_boot.ts` beside `hasPlatformDb` — which is where the two-tier
  // rule is argued — so the policy is testable without opening a pool, and so a
  // fourth requirement is one edit rather than a third call here. Its doc carries
  // why each of the three fails silently when absent.
  const realtime = requireEnv(env, PLATFORM_TIER_ENV);
  bootstrapPlatformDb(exec, env);
  // The budget in `MAX_PLATFORM_DB_CONNECTIONS` is a claim about provisioned
  // hardware; this is the one place holding a connection to check it against.
  //
  // Takes THIS env rather than reading `process.env` itself, because the claim
  // depends on one of its variables: `PLATFORM_POOLER_URL` decides whether the
  // admin pool costs the instance anything, and the warning above is the term
  // the budget was missing. Both facts were logged and neither was compared.
  announcePlatformDbCapacity(exec, env);
  return {
    secrets: createVaultSecretStore(exec),
    agents: createPgAgentRows(exec),
    workspaces: createPgWorkspaceStore(exec),
    chats: createPgChatStore(exec),
    events: createRealtimePlatformEvents({
      url: realtime.SUPABASE_URL,
      key: realtime.SUPABASE_SERVICE_ROLE_KEY,
    }),
    // Cross-request coordination lives in Postgres too, so any replica (and
    // either service) can serve any request: per-slug mutation exclusion
    // survives replica restarts and scale-out. (Cross-replica sandbox
    // invalidation rides the agents row's change stream — see
    // sandbox-resolve.ts.)
    // Its OWN pool, deliberately: a held slug lock pins its connection for
    // the whole critical section — a deploy's blob uploads, config
    // extraction, and sandbox spawn, i.e. seconds — while every other
    // statement here is a single short query. Sharing one pool let a handful
    // of concurrent distinct-slug deploys hold every connection and starve
    // Vault reads, workspace writes, and the agents-row lookups the broker
    // makes, on a replica that was otherwise healthy. Separated, lock
    // acquires queue only against each other.
    // The slug-lock pool takes the connect bound and NEITHER query bound: its
    // whole job is holding an advisory lock on a RESERVED connection for a
    // deploy's duration, so `reservedQueryTimeoutMs` — which the admin pool
    // above does set — would abort deploys here. The wait that does need a
    // bound, the ACQUIRE, carries its own `lock_timeout` on the connection
    // (`platform-lock.ts`). This is the whole reason that option is per-pool
    // rather than a blanket on `reserve()`.
    //
    // `reserveTimeoutMs` is refused on the same ground and it is the sharper
    // case: a reservation here is held for a whole deploy, so a fifth
    // concurrent distinct-slug mutation waits minutes for a connection
    // LEGITIMATELY. A deadline would turn ordinary deploy concurrency into a
    // failure, where on the admin pool the same wait can only mean exhaustion.
    slugLock: createPgSlugLock(
      platformDb(
        createPostgresDb({
          url,
          max: SLUG_LOCK_POOL_MAX,
          connectTimeoutSeconds: PLATFORM_DB_CONNECT_TIMEOUT_SECONDS,
        }),
      ),
    ),
    sql: exec,
    adminDb: {
      // The admin POOL for the reservation: the platform's own sweeps take one
      // per tick, so the fleet-wide budget (MAX_PLATFORM_DB_CONNECTIONS) is
      // unchanged by any of them.
      reserve: () => admin.reserve(),
      // ...and the dedicated session-mode handle for the subscription.
      listen: (channel, onNotify) => queueListener().listen(channel, onNotify),
    },
  };
}

/**
 * Assemble the shared service bindings from the environment.
 *
 * **Still async, and no longer for the reason it became async.** It was awaiting
 * `createPlatformWorldStorage` — the DevKit's world on the platform's own
 * database — and the lesson from that binding is worth keeping now the binding
 * is gone: `ServiceConfig` DECLARED it for months while nothing filled it, so
 * `/:slug/workflow-storage` answered 501 on every deployment while the guest
 * routed to it unconditionally, and every durable run died at its first
 * `events.create`. A binding whose construction lives in a second place is a
 * binding an entry can forget. This is the one function that reads the
 * environment and builds them, so anything new belongs here too.
 */
export async function buildServiceConfig(env: NodeJS.ProcessEnv): Promise<ServiceConfig> {
  // One key, two consumers that both need service-role authority (Storage
  // blobs below, the Realtime streams in buildPlatformDb) and neither of which
  // reports an anon key as a credential problem — see assertServiceRoleKey.
  // Checked here rather than at each consumer because this is the only caller
  // of both, so one guard cannot be half-applied.
  //
  // Checked wherever the key is SET, local runs included. It used to be skipped
  // in local dev, which exempted the one tier where a developer is most likely
  // to have pasted the publishable key by mistake — and both symptoms there are
  // the misleading ones the assertion exists to pre-empt (a deploy that fails on
  // `storage.objects` RLS; a Realtime channel that rejoins in silence forever).
  if (env.SUPABASE_SERVICE_ROLE_KEY) assertServiceRoleKey(env.SUPABASE_SERVICE_ROLE_KEY);
  assertGuestTokenSecret(env, hasPlatformDb(env));
  const storage = buildStorage(env);
  const uploadBytes = buildUploadBytes(env);
  const { secrets, agents, workspaces, chats, events, slugLock, sql, adminDb } =
    buildPlatformDb(env);
  const slots = createSlotCache();
  // Per-process, not per-host: Modal can run several containers of the same
  // app anywhere, and two of them sharing an identity is exactly the failure
  // the studio session registry exists to prevent (see
  // ServiceConfig.replicaId).
  const replicaId = randomUUID();
  // The fleet-wide sandbox directory is Modal itself (sandbox-directory.ts):
  // a sandbox's identity is its NAME, so there is no table to register in and
  // nothing to heartbeat. Only the Modal backend has a control plane to ask.
  const directory =
    resolveSandboxBackend(env) === "modal" ? createModalSandboxDirectory() : undefined;
  // Browser-session auth: Supabase when configured, the no-auth dev-token
  // implementation only on a run that has NO platform database (see
  // createStudioAuthFromEnv — a platform database refuses dev tokens outright).
  // Unconfigured production still serves CLI (raw-key) traffic, so warn rather
  // than fail.
  const auth = createStudioAuthFromEnv(env);
  if (!auth) {
    log.warn("SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY not set — studio browser login is disabled");
  }
  // Raw API-key bearers are verified against AssemblyAI before they can claim
  // a slug or spawn a sandbox (api-key-verify.ts). Undefined only under an
  // explicit `AAI_LOCAL_DEV=1` or `AAI_VERIFY_API_KEYS=0`, so a boot that forgot
  // a variable gets verification rather than a hole.
  const keyVerifier = createApiKeyVerifierFromEnv(env, { localDev: isLocalDev(env) });
  return {
    slots,
    // Blob storage serves deploy artifacts only (content-addressed worker +
    // client-file blobs); the deploy records live in the agents table and
    // studio workspaces/chats in Postgres via `workspaces`/`chats`.
    store: createBundleStore(storage, { secrets, agents }),
    // Where a workflow upload's WINDOWS go. Not part of the bundle store: it is the
    // same bucket and the same credential, and nothing else about it is the same — the
    // keys are not content hashes, the objects are mutable within one upload, and its
    // one consumer is a route rather than a deploy.
    uploadBytes,
    workspaces,
    chats,
    events,
    secrets,
    ...omitUndefined({ auth }),
    ...omitUndefined({ keyVerifier }),
    slugLock,
    replicaId,
    ...omitUndefined({ sql }),
    ...omitUndefined({ adminDb }),
    ...omitUndefined({ directory }),
  };
}

// The boot ANNOUNCEMENTS and the process safety nets live in service-boot.ts —
// re-exported here because this is the subpath the service entry imports, so
// the split stays internal to the package.
export {
  assertSandboxBackendOrWarn,
  installProcessSafetyNets,
} from "./service-boot.ts";
