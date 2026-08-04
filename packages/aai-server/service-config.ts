// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared service configuration for the platform's deployable entries — the
 * agent service (this package's index.ts) and the studio/combined entries
 * (the aai-studio-server package). One implementation of "read the
 * environment, build the platform bindings" so the services cannot drift on
 * storage, Vault, locks, or change-stream wiring.
 */

import { randomUUID } from "node:crypto";
import { createPostgresDb } from "@alexkroman1/aai/runtime";
import { createStorage } from "unstorage";
import { isLocalDev, requireEnv, resolvePoolSize } from "./_boot.ts";
import { type AgentRows, createMemoryAgentRows, createPgAgentRows } from "./agent-store.ts";
import { type AppDatabases, type AppDbTarget, createAppDatabases } from "./app-database.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore, createPgChatStore } from "./chat-store.ts";
import { resolveHarnessPath } from "./constants.ts";
import { isModalConfigured, modalRequiredError, prewarmModal } from "./modal-sandbox.ts";
import type { OrchestratorOpts } from "./orchestrator.ts";
import { schedulePlatformSweeps } from "./pg-cron.ts";
import {
  createMemoryPlatformEvents,
  type PlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform-events.ts";
import { createPgSlugLock, localSlugLock, type SlugMutationLock } from "./platform-lock.ts";
import { createRealtimePlatformEvents, ensureRealtimeSetup } from "./realtime-events.ts";
import { createS3Storage } from "./s3-storage.ts";
import { describeSandboxBackend } from "./sandbox-backend.ts";
import { createSandboxPool, type SandboxPool } from "./sandbox-pool.ts";
import {
  createMemorySandboxRegistry,
  createPgSandboxRegistry,
  type SandboxRegistry,
} from "./sandbox-registry.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { spawnWarmHarness } from "./sandbox-vm.ts";
import {
  createMemorySecretStore,
  createVaultSecretStore,
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
      const db = createPostgresDb({ url, max: 4 });
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
};

export function buildPool(env: NodeJS.ProcessEnv): SandboxPool | null {
  const size = resolvePoolSize(env.SANDBOX_POOL_SIZE);
  if (size === null) return null;
  const harnessPath = resolveHarnessPath(env);
  console.info(`Sandbox pool: pre-warming ${size} guest harness(es)`, { harnessPath });
  return createSandboxPool({
    targetSize: size,
    spawn: () => spawnWarmHarness({ harnessPath }),
  });
}

export function buildStorage(env: NodeJS.ProcessEnv): ReturnType<typeof createStorage> {
  if (isLocalDev(env)) {
    console.info("Local dev mode: unstorage memory driver for all storage");
    return createStorage();
  }
  const required = requireEnv(env, [
    "SUPABASE_S3_ENDPOINT",
    "SUPABASE_S3_ACCESS_KEY_ID",
    "SUPABASE_S3_SECRET_ACCESS_KEY",
    "SUPABASE_STORAGE_BUCKET",
  ]);
  return createS3Storage({
    bucket: required.SUPABASE_STORAGE_BUCKET,
    endpoint: required.SUPABASE_S3_ENDPOINT,
    // Supabase's S3-compatible endpoint expects the project's region string.
    region: env.SUPABASE_S3_REGION ?? "us-east-1",
    accessKeyId: required.SUPABASE_S3_ACCESS_KEY_ID,
    secretAccessKey: required.SUPABASE_S3_SECRET_ACCESS_KEY,
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
  registry: SandboxRegistry;
} {
  const memory = createMemoryPlatformEvents();
  return {
    agents: withAgentEvents(createMemoryAgentRows(), memory.emitAgent),
    workspaces: withWorkspaceEvents(createMemoryWorkspaceStore(), memory.emitWorkspace),
    chats: withChatEvents(createMemoryChatStore(), memory.emitChat),
    events: memory.events,
    // Inert in one process (listPeers excludes own rows); interface parity.
    registry: createMemorySandboxRegistry(randomUUID()),
  };
}

/**
 * Boot-time database housekeeping for production: the Realtime publication
 * the change streams depend on, and the pg_cron janitorial sweeps. Loud on
 * failure, but deliberately not fatal — with no publication, superseded
 * sandboxes last until idle eviction and previews until the next project
 * open; a missing sweep degrades to table growth. Neither is worth
 * refusing to serve traffic over.
 */
function bootstrapPlatformDb(sql: SqlExec): void {
  ensureRealtimeSetup(sql).catch((err: unknown) => {
    console.error("Realtime publication setup failed — change streams will not fire:", err);
  });
  schedulePlatformSweeps(sql).catch((err: unknown) => {
    console.error("pg_cron sweep scheduling failed — janitorial sweeps will not run:", err);
  });
}

/**
 * Platform Postgres surface: Supabase Vault for secrets, studio workspaces,
 * per-app database provisioning, and the Realtime change streams — all over
 * `SUPABASE_DB_URL` (service-role connection string) plus `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` for the Realtime socket. Required in
 * production; local dev falls back to in-memory stores and the in-process
 * event emitter (and no per-app databases unless SUPABASE_DB_URL is set).
 */
export function buildPlatformDb(env: NodeJS.ProcessEnv): {
  secrets: SecretStore;
  /** The agents table (deploy records). Postgres in production, memory in dev. */
  agents: AgentRows;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  /** Change notifications — see ServiceConfig.events. */
  events: PlatformEvents;
  /** Cross-replica sandbox registry — see sandbox-registry.ts. */
  registry: SandboxRegistry;
  appDb?: AppDatabases;
  /** Cross-replica slug mutation lock; in-process without a platform db. */
  slugLock: SlugMutationLock;
  /** Platform admin SQL executor (production only) — see ServiceConfig.sql. */
  sql?: SqlExec;
} {
  const url = env.SUPABASE_DB_URL;
  if (!url) {
    if (!isLocalDev(env)) {
      requireEnv(env, ["SUPABASE_DB_URL"]); // throws with the standard message
    }
    console.info(
      "Local dev mode: in-memory secret + studio workspace/chat stores; per-app databases disabled",
    );
    return {
      secrets: createMemorySecretStore(),
      ...buildMemoryStores(),
      slugLock: localSlugLock,
    };
  }
  // The pool lives for the process; connections drain when the process exits
  // (no explicit close() hook on the shutdown path today).
  // `quietDdlNotices`: every store bootstraps its own schema with
  // `create ... if not exists` (pg-ensure.ts), and each container that boots
  // re-runs all of them. Unfiltered, the driver dumps a multi-line notice
  // object per statement — dozens per autoscale event — into the same log an
  // operator greps for real failures.
  const admin = createPostgresDb({ url, max: 4, quietDdlNotices: true });
  const exec: SqlExec = (query, params) => admin.query(query, params);
  const localDev = isLocalDev(env);
  if (localDev) {
    return {
      secrets: createMemorySecretStore(),
      ...buildMemoryStores(),
      appDb: createAppDatabases({
        url,
        sql: exec,
        extraTargets: parseExtraAppDbTargets(env.APP_DB_URLS),
      }),
      slugLock: localSlugLock,
    };
  }
  // Production: change notifications ride Supabase Realtime — the Postgres
  // rows are the emitters (postgres_changes), so unlike the memory path the
  // stores need no write-side wrapping.
  const realtime = requireEnv(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  bootstrapPlatformDb(exec);
  return {
    secrets: createVaultSecretStore(exec),
    agents: createPgAgentRows(exec),
    workspaces: createPgWorkspaceStore(exec),
    chats: createPgChatStore(exec),
    events: createRealtimePlatformEvents({
      url: realtime.SUPABASE_URL,
      key: realtime.SUPABASE_SERVICE_ROLE_KEY,
    }),
    registry: createPgSandboxRegistry(exec, { replicaId: randomUUID() }),
    appDb: createAppDatabases({
      url,
      sql: exec,
      // Cellular sharding: APP_DB_URLS lists additional Supabase clusters
      // new apps may be placed on. Each app's cluster is recorded in its
      // app-db:<slug> locator, so agent code never notices placement.
      extraTargets: parseExtraAppDbTargets(env.APP_DB_URLS),
    }),
    // Cross-request coordination lives in Postgres too, so any replica (and
    // either service) can serve any request: per-slug mutation exclusion
    // survives replica restarts and scale-out. (Cross-replica sandbox
    // invalidation rides the agents row's change stream — see
    // sandbox-resolve.ts.)
    slugLock: createPgSlugLock(exec),
    sql: exec,
  };
}

/** Assemble the shared service bindings from the environment. */
export function buildServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const storage = buildStorage(env);
  const { secrets, agents, workspaces, chats, events, registry, appDb, slugLock, sql } =
    buildPlatformDb(env);
  const slots = createSlotCache();
  const pool = buildPool(env);
  // Browser-session auth: Supabase when configured, the dev-token
  // implementation in local dev (same policy as the in-memory stores —
  // production can never resolve it). Unconfigured production still serves
  // CLI (raw-key) traffic, so warn rather than fail.
  const auth = createStudioAuthFromEnv(env, { localDev: isLocalDev(env) });
  if (!auth) {
    console.warn(
      "[auth] SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY not set — studio browser login is disabled",
    );
  }
  return {
    slots,
    // Blob storage serves deploy artifacts only (content-addressed worker +
    // client-file blobs); the deploy records live in the agents table and
    // studio workspaces/chats in Postgres via `workspaces`/`chats`.
    store: createBundleStore(storage, { secrets, agents }),
    workspaces,
    chats,
    events,
    registry,
    secrets,
    ...(auth && { auth }),
    slugLock,
    ...(appDb && { appDb }),
    ...(pool && { pool }),
    ...(sql && { sql }),
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
    // Resolve the Modal app/image context now (fire-and-forget) so the gRPC
    // round trip doesn't land on the first session's cold start.
    prewarmModal();
  }
}

/** Process-level safety nets, registered before anything else at boot. */
export function installProcessSafetyNets(): void {
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    process.exit(1);
  });
}
