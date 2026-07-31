// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI platform server.
 *
 * Creates the Hono orchestrator backed by Supabase Storage (S3-compatible)
 * via unstorage — with agent secrets in Supabase Vault and per-app databases
 * in Supabase Postgres — and starts a Node.js HTTP server with WebSocket
 * upgrade support via `ws`.
 */

import {
  createMemoryVector,
  createPineconeVector,
  createPostgresDb,
  type Vector,
} from "@alexkroman1/aai/runtime";
import { serve } from "@hono/node-server";
import { createStorage } from "unstorage";
import { assertDevKeys, isLocalDev, requireEnv, resolveDrainMs, resolvePoolSize } from "./_boot.ts";
import { waitForIdle } from "./_drain.ts";
import { type AppDatabases, createAppDatabases } from "./app-database.ts";
import { createBundleStore } from "./bundle-store.ts";
import { DEFAULT_PORT, resolveHarnessPath } from "./constants.ts";
import { isModalConfigured, modalRequiredError, prewarmModal } from "./modal-sandbox.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { createMemorySlugEpochs, createPgSlugEpochs, type SlugEpochs } from "./platform-epoch.ts";
import { createPgSlugLock, localSlugLock, type SlugMutationLock } from "./platform-lock.ts";
import { createS3Storage } from "./s3-storage.ts";
import { createSandboxPool, type SandboxPool } from "./sandbox-pool.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { spawnWarmHarness } from "./sandbox-vm.ts";
import {
  createMemorySecretStore,
  createVaultSecretStore,
  type SecretStore,
  type SqlExec,
} from "./secret-store.ts";
import {
  createMemorySessionStateStore,
  createPgSessionStateStore,
  type SessionStateStore,
} from "./session-state-store.ts";
import { type ChatStore, createMemoryChatStore, createPgChatStore } from "./studio/chat-store.ts";
import { createStudioApp } from "./studio/studio-app.ts";
import {
  CHAT_RATE_LIMIT,
  createPgRateLimiter,
  PROJECT_CREATE_RATE_LIMIT,
  type StudioRateLimiters,
} from "./studio/studio-rate-limit.ts";
import {
  createMemoryWorkspaceStore,
  createPgWorkspaceStore,
  type WorkspaceStore,
} from "./studio/workspace-store.ts";

function buildPool(env: NodeJS.ProcessEnv): SandboxPool | null {
  const size = resolvePoolSize(env.SANDBOX_POOL_SIZE);
  if (size === null) return null;
  const harnessPath = resolveHarnessPath(env);
  console.info(`Sandbox pool: pre-warming ${size} Deno harness(es)`, { harnessPath });
  return createSandboxPool({
    targetSize: size,
    spawn: () => spawnWarmHarness({ harnessPath }),
  });
}

function buildStorage(env: NodeJS.ProcessEnv): ReturnType<typeof createStorage> {
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
 * Platform Postgres surface: Supabase Vault for secrets, studio workspaces,
 * and per-app database provisioning, all over `SUPABASE_DB_URL`
 * (service-role connection string). Required in production; local dev falls
 * back to in-memory secret and workspace stores (and no per-app databases
 * unless SUPABASE_DB_URL is set).
 */
function buildPlatformDb(env: NodeJS.ProcessEnv): {
  secrets: SecretStore;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  appDb?: AppDatabases;
  /** Cross-replica slug mutation lock; in-process without a platform db. */
  slugLock: SlugMutationLock;
  /** Cross-replica studio rate limiters; per-process memory without one. */
  studioRateLimiters?: StudioRateLimiters;
  /** Cross-replica session-resume state; per-process memory without a db. */
  sessionStates: SessionStateStore;
  /** Cross-replica/service invalidation epochs; per-process memory without a db. */
  slugEpochs: SlugEpochs;
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
      workspaces: createMemoryWorkspaceStore(),
      chats: createMemoryChatStore(),
      slugLock: localSlugLock,
      sessionStates: createMemorySessionStateStore(),
      slugEpochs: createMemorySlugEpochs(),
    };
  }
  // The pool lives for the process; connections drain when the process exits
  // (no explicit close() hook on the shutdown path today).
  const admin = createPostgresDb({ url, max: 4 });
  const exec: SqlExec = (query, params) => admin.query(query, params);
  const localDev = isLocalDev(env);
  return {
    secrets: localDev ? createMemorySecretStore() : createVaultSecretStore(exec),
    workspaces: localDev ? createMemoryWorkspaceStore() : createPgWorkspaceStore(exec),
    chats: localDev ? createMemoryChatStore() : createPgChatStore(exec),
    appDb: createAppDatabases({ url, sql: exec }),
    // Cross-request coordination lives in Postgres too, so any replica can
    // serve any request: per-slug mutation exclusion and the studio's
    // fixed-window rate limits both survive replica restarts and scale-out.
    slugLock: localDev ? localSlugLock : createPgSlugLock(exec),
    sessionStates: localDev ? createMemorySessionStateStore() : createPgSessionStateStore(exec),
    slugEpochs: localDev ? createMemorySlugEpochs() : createPgSlugEpochs(exec),
    ...(localDev
      ? {}
      : {
          studioRateLimiters: {
            chat: createPgRateLimiter(exec, { name: "studio-chat", ...CHAT_RATE_LIMIT }),
            projectCreate: createPgRateLimiter(exec, {
              name: "studio-project-create",
              ...PROJECT_CREATE_RATE_LIMIT,
            }),
          },
        }),
  };
}

function buildDefaultVector(env: NodeJS.ProcessEnv): (slug: string) => Vector {
  if (isLocalDev(env) || !env.PINECONE_API_KEY || !env.PINECONE_INDEX) {
    return (slug) => createMemoryVector({ namespace: slug });
  }
  const apiKey = env.PINECONE_API_KEY;
  const index = env.PINECONE_INDEX;
  return (slug) => createPineconeVector({ apiKey, index, namespace: slug });
}

function buildOpts(env: NodeJS.ProcessEnv): OrchestratorOpts {
  const storage = buildStorage(env);
  const {
    secrets,
    workspaces,
    chats,
    appDb,
    slugLock,
    studioRateLimiters,
    sessionStates,
    slugEpochs,
  } = buildPlatformDb(env);
  const slots = createSlotCache();
  const pool = buildPool(env);
  return {
    slots,
    // Blob storage serves deploy artifacts only (bundles/client files);
    // studio workspaces and chats live in Postgres via `workspaces`/`chats`.
    store: createBundleStore(storage, { secrets }),
    workspaces,
    chats,
    secrets,
    slugLock,
    slugEpochs,
    sessionStates,
    defaultVector: buildDefaultVector(env),
    ...(appDb && { appDb }),
    ...(studioRateLimiters && { studioRateLimiters }),
    ...(pool && { pool }),
  };
}

/**
 * Which surface this process serves (`AAI_SERVICE`):
 * - `combined` (default) — agent backend with the studio mounted in-process;
 *   what `aai dev` and single-service deployments run.
 * - `agent` — voice sessions + platform API, with the studio surface
 *   reverse-proxied to `STUDIO_UPSTREAM_URL` (required in this mode).
 * - `studio` — the standalone studio service (see studio/studio-app.ts).
 */
function resolveServiceMode(env: NodeJS.ProcessEnv): "combined" | "agent" | "studio" {
  const raw = env.AAI_SERVICE ?? "combined";
  if (raw === "combined" || raw === "agent" || raw === "studio") return raw;
  throw new Error(`Invalid AAI_SERVICE "${raw}" — expected combined | agent | studio`);
}

async function main(): Promise<void> {
  // Register process-level safety nets FIRST — an unhandled rejection or
  // uncaught exception during startup (storage init, pool pre-warm) must be
  // logged, not silently subject to Node's defaults.
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    process.exit(1);
  });

  const env = process.env;
  assertDevKeys(env);
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  const mode = resolveServiceMode(env);

  // Flipped by `shutdown()` before anything is torn down: it fails /health
  // so the platform's proxy stops routing here, and refuses new WebSocket
  // upgrades. Both are needed for the drain below to converge — otherwise the
  // replica keeps accepting the sessions it is waiting to finish.
  let draining = false;
  const base = buildOpts(env);
  // Agent mode without a studio upstream would silently serve 404s for the
  // whole studio surface — a config error, so it fails at boot.
  if (mode === "agent") requireEnv(env, ["STUDIO_UPSTREAM_URL"]);
  const opts: OrchestratorOpts = {
    ...base,
    isDraining: () => draining,
    ...(mode === "agent" && env.STUDIO_UPSTREAM_URL && { studioUpstream: env.STUDIO_UPSTREAM_URL }),
  };

  // Sandboxes run on Modal — fail at boot when credentials are missing, where
  // the cause is obvious, instead of on the first session's spawn. Local dev
  // only warns so the studio's non-sandbox surfaces (editor, static routes)
  // stay usable without Modal credentials.
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

  // The standalone studio service: no voice sessions, no WebSocket upgrades,
  // no slot cache — chat turns are bounded HTTP/SSE requests, so shutdown is
  // flip-health-and-close rather than the agent service's session drain.
  if (mode === "studio") {
    const { app } = createStudioApp({ ...base, isDraining: () => draining });
    const nodeServer = serve({ fetch: app.fetch, port });
    nodeServer.on("error", (err) => {
      console.error("HTTP server error:", err);
      process.exit(1);
    });
    await new Promise<void>((resolve) => {
      nodeServer.on("listening", resolve);
    });
    console.info(`AAI studio service listening on http://localhost:${port}`);
    let stopping = false;
    const stopStudio = async () => {
      if (stopping) return;
      stopping = true;
      draining = true;
      console.info("Studio service shutting down...");
      if (base.pool) await base.pool.shutdown().catch(() => undefined);
      nodeServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", () => void stopStudio());
    process.on("SIGTERM", () => void stopStudio());
    return;
  }

  const { app, injectWebSocket, closeActiveSockets, activeSessionCount } = createOrchestrator(opts);
  const nodeServer = serve({ fetch: app.fetch, port });
  injectWebSocket(nodeServer as import("node:http").Server);

  // Without a listener, a listen failure (e.g. EADDRINUSE) gets Node's
  // default throw-from-nowhere. Log it usefully and exit.
  nodeServer.on("error", (err) => {
    console.error("HTTP server error:", err);
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    nodeServer.on("listening", resolve);
  });

  console.info(`AAI server listening on http://localhost:${port}`);

  let shuttingDown = false;
  async function shutdown() {
    // Re-entrancy guard: a second SIGTERM/SIGINT during teardown must not
    // run sandbox shutdown twice.
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop taking work before waiting for it to finish, then let live calls
    // end on their own. A voice session is a long-lived socket, so closing
    // them immediately (which this used to do) cut every conversation in
    // flight on every deploy — both strategies replace all machines, so that
    // was every active call, mid-sentence.
    draining = true;
    const active = activeSessionCount();
    const drainMs = resolveDrainMs(env.SHUTDOWN_DRAIN_MS);
    console.info("Draining active sessions...", { active, drainMs });
    const { drained, remaining } = await waitForIdle({
      activeCount: activeSessionCount,
      timeoutMs: drainMs,
    });
    if (!drained) {
      // Deliberately loud: this is a call that got cut, and the deadline is
      // only correct if it is rarely hit. The platform SIGKILLs when the stop
      // grace period lapses, so waiting past it is not an option.
      console.warn("Drain deadline reached; closing sessions still in flight", { remaining });
    }

    console.info("Shutting down...");
    // Close client WebSockets: `nodeServer.close()` only waits for
    // connections to end, it never ends them, so open sessions would ride
    // out the whole fallback timeout on every SIGTERM under load.
    closeActiveSockets();
    const stops = [...opts.slots.values()].map((slot) => slot.sandbox?.shutdown()).filter(Boolean);
    if (opts.pool) stops.push(opts.pool.shutdown());
    const results = await Promise.allSettled(stops);
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("Sandbox termination failed:", r.reason);
      }
    }
    nodeServer.close(() => process.exit(0));
    // Sandboxes are already down by here; a straggling connection is not a
    // failed shutdown, so the fallback exits 0 (it used to exit 1, flagging
    // every busy SIGTERM as a crash).
    setTimeout(() => {
      console.warn("Shutdown timed out waiting for connections to close; exiting");
      process.exit(0);
    }, 3000).unref();
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
