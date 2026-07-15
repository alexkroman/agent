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
import s3Driver from "unstorage/drivers/s3";
import { createBundleStore } from "./bundle-store.ts";
import { DEFAULT_PORT, resolveHarnessPath } from "./constants.ts";
import { isGvisorAvailable, prepareRootfs } from "./gvisor.ts";
import { initHostCapacityGauges, metrics } from "./metrics.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { createSandboxPool, type SandboxPool } from "./sandbox-pool.ts";
import { createSlotCache, registerSlotsForGauges } from "./sandbox-slots.ts";
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

function buildPool(env: NodeJS.ProcessEnv): SandboxPool | null {
  const raw = env.SANDBOX_POOL_SIZE;
  if (!raw) return null;
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 1) return null;
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
  const storage = createStorage({
    driver: s3Driver({
      bucket: required.BUCKET_NAME,
      endpoint: env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev",
      region: "auto",
      accessKeyId: required.AWS_ACCESS_KEY_ID,
      secretAccessKey: required.AWS_SECRET_ACCESS_KEY,
    }),
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
  const env = process.env;
  initHostCapacityGauges();
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);

  const opts = await buildOpts(env);

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

  const { app, injectWebSocket } = createOrchestrator(opts);
  const nodeServer = serve({ fetch: app.fetch, port });
  injectWebSocket(nodeServer as import("node:http").Server);

  await new Promise<void>((resolve) => {
    nodeServer.on("listening", resolve);
  });

  console.info(`AAI server listening on http://localhost:${port}`);

  async function shutdown() {
    console.info("Shutting down...");
    const stops = [...opts.slots.values()].map((slot) => slot.sandbox?.shutdown()).filter(Boolean);
    if (opts.pool) stops.push(opts.pool.shutdown());
    const results = await Promise.allSettled(stops);
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("Sandbox termination failed:", r.reason);
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
