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
import { createPostgresDb } from "@alexkroman1/aai/runtime";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { assertServiceRoleKey, hasPlatformDb, isLocalDev, requireEnv } from "./_boot.ts";
import { type AgentRows, createMemoryAgentRows, createPgAgentRows } from "./agent-store.ts";
import { createApiKeyVerifierFromEnv } from "./api-key-verify.ts";
import { type AppDatabases, type AppDbTarget, createAppDatabases } from "./app-database.ts";
import {
  assertBucketPrivate,
  type BlobStorage,
  createMemoryBlobStorage,
  createSupabaseBlobStorage,
} from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore, createPgChatStore } from "./chat-store.ts";
import {
  ADMIN_POOL_MAX,
  APP_DB_TARGET_POOL_MAX,
  resolveHarnessPath,
  SLUG_LOCK_POOL_MAX,
} from "./constants.ts";
import { endLiveStreams } from "./live-streams.ts";
import { isModalConfigured, modalRequiredError, prewarmModal } from "./modal-context.ts";
import { createModalSandboxDirectory } from "./modal-sandbox-directory.ts";
import type { OrchestratorOpts } from "./orchestrator.ts";
import { platformCronJobs, schedulePlatformSweeps } from "./pg-cron.ts";
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
import { createRealtimePlatformEvents } from "./realtime-events.ts";
import { describeSandboxBackend, resolveSandboxBackend } from "./sandbox-backend.ts";
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

/** Comma-separated extra placement clusters (APP_DB_URLS) → pooled targets. */
function parseExtraAppDbTargets(raw: string | undefined): AppDbTarget[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => {
      const db = createPostgresDb({ url, max: APP_DB_TARGET_POOL_MAX });
      return { url, sql: (query, params) => db.query(query, params) } satisfies AppDbTarget;
    });
}

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
 * Verify the deploy-artifact bucket at boot — see {@link assertBucketPrivate}
 * for what is fatal and what merely warns.
 *
 * Separate from {@link buildStorage} because it is ASYNC and that one is not:
 * the entry awaits this once, beside the other boot assertions, rather than
 * every construction of a storage handle paying a round trip.
 */
export async function assertStorageBucket(env: NodeJS.ProcessEnv): Promise<void> {
  // No platform database is the memory blob store — there is no bucket to check.
  if (!hasPlatformDb(env)) return;
  const required = requireEnv(env, [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_STORAGE_BUCKET",
  ]);
  await assertBucketPrivate({
    url: required.SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    bucket: required.SUPABASE_STORAGE_BUCKET,
  });
}

export function buildStorage(env: NodeJS.ProcessEnv): BlobStorage {
  if (!hasPlatformDb(env)) {
    console.info(
      "No SUPABASE_DB_URL: in-memory blob storage for deploy artifacts — " +
        "deploys are LOST on restart",
    );
    return createMemoryBlobStorage();
  }
  // Storage authenticates with the SAME service-role key the Realtime socket
  // uses — no separate S3 credential pair for a project we already hold two
  // credentials for (see blob-storage.ts).
  const required = requireEnv(env, [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_STORAGE_BUCKET",
  ]);
  return createSupabaseBlobStorage({
    url: required.SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    bucket: required.SUPABASE_STORAGE_BUCKET,
  });
}

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
    if (storage && key) await createVaultSecretStore(sql).put(PLATFORM_STORAGE_KEY_SECRET, key);
    await schedulePlatformSweeps(sql, platformCronJobs({ ...(storage && { storage }) }));
  };
  bootstrap().catch((err: unknown) => {
    console.error("pg_cron sweep scheduling failed — janitorial sweeps will not run:", err);
  });
}

/**
 * Platform Postgres surface: Supabase Vault for secrets, studio workspaces,
 * per-app database provisioning, and the Realtime change streams — all over
 * `SUPABASE_DB_URL` (service-role connection string) plus `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` for the Realtime socket.
 *
 * **`SUPABASE_DB_URL` decides the whole tier, and there are exactly two.** Set,
 * every store here is Supabase's and the companions are REQUIRED; unset, every
 * store is memory and nothing survives a restart. See {@link hasPlatformDb} for
 * why the third state — memory stores beside real per-app databases — is gone
 * rather than merely discouraged.
 */
export function buildPlatformDb(env: NodeJS.ProcessEnv): {
  secrets: SecretStore;
  /** The agents table (deploy records). Postgres with a platform db, else memory. */
  agents: AgentRows;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  /** Change notifications — see ServiceConfig.events. */
  events: PlatformEvents;
  appDb?: AppDatabases;
  /** Cross-replica slug mutation lock; in-process without a platform db. */
  slugLock: SlugMutationLock;
  /** Platform admin SQL executor, with a platform db — see ServiceConfig.sql. */
  sql?: SqlExec;
  /**
   * The admin pool itself, for the one consumer that needs a RESERVED
   * connection rather than a statement: the durable-workflow wake sweep, whose
   * pass is one transaction holding an advisory lock and a `set local`
   * statement timeout (workflow-wake.ts).
   */
  adminDb?: AdminDb;
  /** Extra `APP_DB_URLS` clusters — see OrchestratorOpts.extraAppDbClusters. */
  extraAppDbClusters?: number;
} {
  const url = env.SUPABASE_DB_URL;
  if (!url) {
    console.info(
      "No SUPABASE_DB_URL: in-memory secret/agents/workspace/chat stores, no per-app " +
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
  const admin = createPostgresDb({ url, max: ADMIN_POOL_MAX });
  const exec: SqlExec = (query, params) => admin.query(query, params);
  const extraTargets = parseExtraAppDbTargets(env.APP_DB_URLS);
  // Change notifications ride Supabase Realtime — the Postgres rows are the
  // emitters (postgres_changes), so unlike the memory path the stores need no
  // write-side wrapping. Required rather than optional: a platform database with
  // no Realtime credential is a server that never invalidates a resident sandbox
  // on redeploy and never pushes studio SSE, and BOTH of those failures are
  // silent (see realtime-events.ts on the channel that rejoins forever).
  const realtime = requireEnv(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  bootstrapPlatformDb(exec, env);
  return {
    secrets: createVaultSecretStore(exec),
    agents: createPgAgentRows(exec),
    workspaces: createPgWorkspaceStore(exec),
    chats: createPgChatStore(exec),
    events: createRealtimePlatformEvents({
      url: realtime.SUPABASE_URL,
      key: realtime.SUPABASE_SERVICE_ROLE_KEY,
    }),
    appDb: createAppDatabases({
      url,
      sql: exec,
      // Cellular sharding: APP_DB_URLS lists additional Supabase clusters
      // new apps may be placed on. Each app's cluster is recorded in its
      // app-db:<slug> locator, so agent code never notices placement.
      extraTargets,
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
    slugLock: createPgSlugLock(createPostgresDb({ url, max: SLUG_LOCK_POOL_MAX })),
    sql: exec,
    // The admin POOL, not another one: the wake sweep reserves one connection
    // from it for the read phase of a tick, so the fleet-wide connection budget
    // (MAX_PLATFORM_DB_CONNECTIONS, currently exactly at its ceiling) is
    // unchanged by this feature.
    adminDb: admin,
    extraAppDbClusters: extraTargets.length,
  };
}

/** Assemble the shared service bindings from the environment. */
export function buildServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
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
  const storage = buildStorage(env);
  const {
    secrets,
    agents,
    workspaces,
    chats,
    events,
    appDb,
    slugLock,
    sql,
    adminDb,
    extraAppDbClusters,
  } = buildPlatformDb(env);
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
    console.warn(
      "[auth] SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY not set — studio browser login is disabled",
    );
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
    workspaces,
    chats,
    events,
    secrets,
    ...(auth && { auth }),
    ...(keyVerifier && { keyVerifier }),
    slugLock,
    replicaId,
    ...(appDb && { appDb }),
    ...(sql && { sql }),
    ...(adminDb && { adminDb }),
    ...omitUndefined({ extraAppDbClusters }),
    ...(directory && { directory }),
  };
}

/**
 * Boot-time sandbox-backend check, so a misconfiguration fails (or warns)
 * where the cause is obvious instead of on the first session's spawn.
 *
 * The selected backend is logged unconditionally. Previously this only spoke
 * up for missing Modal credentials, so the most confusing configuration of
 * all — auto-selection quietly landing on a backend the developer did not
 * choose — was the one that produced no output at all, and surfaced instead
 * as a spawn failure naming an unexpected backend. That log line also carries
 * the isolation warning: `subprocess` runs tenant code (and the studio coding
 * agent's `bash`/`run_code`) with this process's uid.
 *
 * `subprocess` has no prerequisite to check — that is the point of it being
 * the local-dev default. `modal` needs credentials: fatal in production, a
 * warning in local dev so non-sandbox surfaces stay usable.
 */
export function assertSandboxBackendOrWarn(env: NodeJS.ProcessEnv): void {
  const { backend, reason } = describeSandboxBackend(env);
  console.info(`[sandbox] backend=${backend} (${reason})`);

  if (backend === "subprocess") {
    console.warn(
      "[sandbox] WARNING: guests run as child processes with NO isolation — " +
        "agent code and the studio agent's shell tools share this process's uid, " +
        "filesystem, and network. Set SANDBOX_BACKEND=modal for real sandboxes.",
    );
    return;
  }

  if (!isModalConfigured()) {
    if (isLocalDev(env)) {
      console.warn(
        "[sandbox] WARNING: Modal credentials not configured " +
          "(MODAL_TOKEN_ID/MODAL_TOKEN_SECRET). Sandbox creation will fail.",
      );
    } else {
      throw modalRequiredError();
    }
  } else {
    // Resolve the Modal context AND bake/publish the guest snapshot image now
    // (fire-and-forget), so neither the gRPC round trip nor — far more
    // expensive, and unavoidable on the first boot of every new harness
    // version — the image build lands on the first session's cold start.
    // The harness path is resolved separately: it throws when the harness
    // isn't built, which must not take down boot for a prewarm.
    prewarmModal(harnessPathOrWarn());
  }
}

/** The built harness, or undefined with a warning — a prewarm may not fail boot. */
function harnessPathOrWarn(): string | undefined {
  try {
    return resolveHarnessPath();
  } catch (err) {
    console.warn(`[sandbox] guest image prewarm skipped: ${errorMessage(err)}`);
  }
}

/** Process-level safety nets, registered before anything else at boot. */
export function installProcessSafetyNets(): void {
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    // The other way this process dies with responses open. `process.exit`
    // destroys sockets mid-body, so every live SSE stream would be cut before
    // its terminating chunk — the `TransferEncodingError` of live-streams.ts,
    // with a crash rather than a scale-in behind it. Ending them is synchronous
    // and cannot make the crash worse.
    endLiveStreams();
    process.exit(1);
  });
}
