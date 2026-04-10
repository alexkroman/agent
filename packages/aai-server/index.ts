// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI platform server.
 *
 * Creates the Hono orchestrator backed by Tigris S3 via unstorage and starts
 * a Node.js HTTP server with WebSocket upgrade support via `ws`.
 */

import { serve } from "@hono/node-server";
import { createStorage } from "unstorage";
import s3Driver from "unstorage/drivers/s3";
import { createBundleStore } from "./bundle-store.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { deriveCredentialKey } from "./secrets.ts";

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

async function buildLocalOpts(_env: NodeJS.ProcessEnv): Promise<OrchestratorOpts> {
  console.info("Local dev mode: unstorage memory driver for all storage");
  const storage = createStorage();
  const credentialKey = await deriveCredentialKey("local-dev-secret");
  return {
    slots: createSlotCache(),
    store: createBundleStore(storage, { credentialKey }),
    storage,
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

  const credentialKey = await deriveCredentialKey(required.KV_SCOPE_SECRET);

  const storage = createStorage({
    driver: s3Driver({
      bucket: required.BUCKET_NAME,
      endpoint: env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev",
      region: "auto",
      accessKeyId: required.AWS_ACCESS_KEY_ID,
      secretAccessKey: required.AWS_SECRET_ACCESS_KEY,
    }),
  });

  const store = createBundleStore(storage, { credentialKey });

  return {
    slots: createSlotCache(),
    store,
    storage,
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);

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
    const stops = [...opts.slots.values()].map((slot) => slot.sandbox?.shutdown()).filter(Boolean);
    const results = await Promise.allSettled(stops);
    for (const r of results) {
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
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
