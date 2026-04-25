// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI platform server.
 *
 * Creates the Hono orchestrator backed by Tigris S3 via unstorage and starts
 * a Node.js HTTP server with WebSocket upgrade support via `ws`.
 */

import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { serve } from "@hono/node-server";
import { createStorage } from "unstorage";
import s3Driver from "unstorage/drivers/s3";
import { startEventLoopMonitor } from "./_event-loop-monitor.ts";
import { createBundleStore } from "./bundle-store.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { createSandboxPool, type SandboxPool } from "./sandbox-pool.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { spawnWarmHarness } from "./sandbox-vm.ts";
import { importMasterKey } from "./secrets.ts";

function requireEnv<const K extends string>(
  env: NodeJS.ProcessEnv,
  keys: readonly K[],
): { [P in K]: string } {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as { [P in K]: string };
}

function isLocalDev(env: NodeJS.ProcessEnv): boolean {
  return env.AAI_LOCAL_DEV === "1" || !env.BUCKET_NAME;
}

/**
 * Build the warm-harness pool from env config, or return null if disabled.
 *
 * Set `SANDBOX_POOL_SIZE` to a positive integer to pre-spawn that many
 * Deno harnesses, ready to receive bundle/load. Reduces first-session
 * cold-start latency for any agent that hasn't run yet on this server.
 */
function buildPool(env: NodeJS.ProcessEnv): SandboxPool | null {
  const raw = env.SANDBOX_POOL_SIZE;
  if (!raw) return null;
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 1) return null;
  const harnessPath =
    env.GUEST_HARNESS_PATH ?? path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");
  console.info(`Sandbox pool: pre-warming ${size} Deno harness(es)`, { harnessPath });
  return createSandboxPool({
    targetSize: size,
    spawn: () => spawnWarmHarness({ harnessPath }),
  });
}

async function buildLocalOpts(env: NodeJS.ProcessEnv): Promise<OrchestratorOpts> {
  console.info("Local dev mode: unstorage memory driver for all storage");
  const storage = createStorage();
  const masterKey = await importMasterKey("local-dev-secret");
  const pool = buildPool(env);
  return {
    slots: createSlotCache(),
    store: createBundleStore(storage, { masterKey }),
    storage,
    ...(pool && { pool }),
  };
}

async function buildOpts(env: NodeJS.ProcessEnv): Promise<OrchestratorOpts> {
  if (isLocalDev(env)) return buildLocalOpts(env);

  const required = requireEnv(env, [
    "BUCKET_NAME",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "KV_SCOPE_SECRET",
  ]);

  const masterKey = await importMasterKey(required.KV_SCOPE_SECRET);

  const storage = createStorage({
    driver: s3Driver({
      bucket: required.BUCKET_NAME,
      endpoint: env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev",
      region: "auto",
      accessKeyId: required.AWS_ACCESS_KEY_ID,
      secretAccessKey: required.AWS_SECRET_ACCESS_KEY,
    }),
  });

  const store = createBundleStore(storage, { masterKey });
  const pool = buildPool(env);

  return {
    slots: createSlotCache(),
    store,
    storage,
    ...(pool && { pool }),
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);

  // Event-loop delay monitor: set AAI_EVENT_LOOP_MONITOR=0 to disable.
  // Sustained p95 > 50 ms means CPU-bound work is starving reply dispatch.
  const monitorEnabled = env.AAI_EVENT_LOOP_MONITOR !== "0";
  const loopMonitor = monitorEnabled ? startEventLoopMonitor() : null;

  const opts = await buildOpts(env);
  const { app, injectWebSocket } = createOrchestrator(opts);
  const nodeServer = serve({ fetch: app.fetch, port });
  injectWebSocket(nodeServer as import("node:http").Server);

  await new Promise<void>((resolve) => {
    nodeServer.on("listening", resolve);
  });

  console.info(`AAI server listening on http://localhost:${port}`);

  async function shutdown() {
    console.info("Shutting down...");
    loopMonitor?.stop();
    const stops = [...opts.slots.values()].map((slot) => slot.sandbox?.shutdown()).filter(Boolean);
    if (opts.pool) stops.push(opts.pool.shutdown());
    const results = await Promise.allSettled(stops);
    for (const r of results) {
      if (r.status === "rejected") {
        const msg = errorMessage(r.reason);
        if (!msg.includes("already disposed")) {
          console.warn("Sandbox termination failed:", r.reason);
        }
      }
    }
    nodeServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
