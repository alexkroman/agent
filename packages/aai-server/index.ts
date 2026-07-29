// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI platform server.
 *
 * Creates the Hono orchestrator backed by Tigris S3 via unstorage and starts
 * a Node.js HTTP server with WebSocket upgrade support via `ws`.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createMemoryVector, createPineconeVector, type Vector } from "@alexkroman1/aai/runtime";
import { serve } from "@hono/node-server";
import { createStorage } from "unstorage";
import { assertDevKeys, isLocalDev, requireEnv, resolveDrainMs, resolvePoolSize } from "./_boot.ts";
import { waitForIdle } from "./_drain.ts";
import { createBundleStore } from "./bundle-store.ts";
import { DEFAULT_PORT, resolveHarnessPath } from "./constants.ts";
import { isGvisorAvailable, prepareRootfs } from "./gvisor.ts";
import { initHostCapacityGauges, metrics } from "./metrics.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { createS3Storage } from "./s3-storage.ts";
import { createSandboxPool, type SandboxPool } from "./sandbox-pool.ts";
import { createSlotCache, registerSlotsForGauges } from "./sandbox-slots.ts";
import { spawnWarmHarness } from "./sandbox-vm.ts";
import { importMasterKey } from "./secrets.ts";

function buildPool(env: NodeJS.ProcessEnv): SandboxPool | null {
  const size = resolvePoolSize(env.SANDBOX_POOL_SIZE);
  if (size === null) return null;
  const harnessPath = resolveHarnessPath(env);
  console.info(`Sandbox pool: pre-warming ${size} Deno harness(es)`, { harnessPath });
  metrics.warmPoolTarget.set(size);
  return createSandboxPool({
    targetSize: size,
    spawn: () => spawnWarmHarness({ harnessPath }),
  });
}

function buildStorage(env: NodeJS.ProcessEnv): {
  storage: ReturnType<typeof createStorage>;
  secret: string;
} {
  if (isLocalDev(env)) {
    console.info("Local dev mode: unstorage memory driver for all storage");
    return { storage: createStorage(), secret: "local-dev-secret" };
  }
  const required = requireEnv(env, [
    "BUCKET_NAME",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "KV_SCOPE_SECRET",
  ]);
  const storage = createS3Storage({
    bucket: required.BUCKET_NAME,
    endpoint: env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev",
    region: "auto",
    accessKeyId: required.AWS_ACCESS_KEY_ID,
    secretAccessKey: required.AWS_SECRET_ACCESS_KEY,
  });
  return { storage, secret: required.KV_SCOPE_SECRET };
}

function buildDefaultVector(env: NodeJS.ProcessEnv): (slug: string) => Vector {
  if (isLocalDev(env) || !env.PINECONE_API_KEY || !env.PINECONE_INDEX) {
    return (slug) => createMemoryVector({ namespace: slug });
  }
  const apiKey = env.PINECONE_API_KEY;
  const index = env.PINECONE_INDEX;
  return (slug) => createPineconeVector({ apiKey, index, namespace: slug });
}

async function buildOpts(env: NodeJS.ProcessEnv): Promise<OrchestratorOpts> {
  const { storage, secret } = buildStorage(env);
  const masterKey = await importMasterKey(secret);
  const slots = createSlotCache();
  registerSlotsForGauges(slots);
  const pool = buildPool(env);
  return {
    slots,
    store: createBundleStore(storage, { masterKey }),
    storage,
    defaultVector: buildDefaultVector(env),
    ...(pool && { pool }),
  };
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
  initHostCapacityGauges();
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);

  // Flipped by `shutdown()` before anything is torn down: it fails /health so
  // fly-proxy stops routing here, and refuses new WebSocket upgrades. Both are
  // needed for the drain below to converge — otherwise the machine keeps
  // accepting the sessions it is waiting to finish.
  let draining = false;
  const opts: OrchestratorOpts = {
    ...(await buildOpts(env)),
    isDraining: () => draining,
  };

  // Pay the rootfs prep cost (deno binary copy, lib mount points) up
  // front, before the HTTP listener is exposed to traffic. Without this,
  // the first sandbox spawn does the ~125 MB sync copy on the request
  // path and blocks the event loop long enough to fail healthchecks.
  if (isGvisorAvailable()) {
    try {
      await prepareRootfs(resolveHarnessPath(env));
    } catch (err) {
      console.warn("Rootfs prep failed at boot; will retry lazily on first spawn", {
        error: errorMessage(err),
      });
    }
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
      // only correct if it is rarely hit. Fly SIGKILLs at kill_timeout, so
      // waiting past it is not an option.
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
