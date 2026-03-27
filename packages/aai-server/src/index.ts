// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI platform server.
 *
 * Creates the Hono orchestrator backed by Tigris S3 via unstorage and starts
 * a Node.js HTTP server with WebSocket upgrade support via `ws`.
 */

import { serve } from "@hono/node-server";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import overlayDriver from "unstorage/drivers/overlay";
import s3Driver from "unstorage/drivers/s3";
import { WebSocketServer } from "ws";
import { createBundleStore } from "./bundle-store.ts";
import { deriveCredentialKey } from "./credentials.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import type { AgentSlot } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox.ts";

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
    slots: new Map<string, AgentSlot>(),
    store: createBundleStore(storage, { credentialKey }),
    storage,
  };
}

async function buildOpts(env: NodeJS.ProcessEnv): Promise<OrchestratorOpts> {
  if (isLocalDev(env)) return buildLocalOpts(env);

  const required = requireEnv(env, ["BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);

  const credentialKey = env.KV_SCOPE_SECRET
    ? await deriveCredentialKey(env.KV_SCOPE_SECRET)
    : await deriveCredentialKey("default-credential-key");

  // Single unstorage instance with overlay (memory cache + S3 persistence).
  // Used for bundles, KV, and vector storage — all in the same Tigris bucket.
  const storage = createStorage({
    driver: overlayDriver({
      layers: [
        memoryDriver(),
        s3Driver({
          bucket: required.BUCKET_NAME,
          endpoint: env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev",
          region: "auto",
          accessKeyId: required.AWS_ACCESS_KEY_ID,
          secretAccessKey: required.AWS_SECRET_ACCESS_KEY,
        }),
      ],
    }),
  });

  const store = createBundleStore(storage, { credentialKey });

  return {
    slots: new Map<string, AgentSlot>(),
    store,
    storage,
  };
}

const SLUG_WS_RE = /^\/([a-z0-9][a-z0-9_-]*[a-z0-9])\/websocket$/;

async function main(): Promise<void> {
  const env = process.env;
  const port = Number.parseInt(env.PORT ?? "8787", 10);

  const opts = await buildOpts(env);
  const app = createOrchestrator(opts);
  const nodeServer = serve({ fetch: app.fetch, port });

  await new Promise<void>((resolve) => {
    nodeServer.on("listening", resolve);
  });

  const wss = new WebSocketServer({ noServer: true });

  nodeServer.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const match = SLUG_WS_RE.exec(url.pathname);
      if (!match) {
        socket.destroy();
        return;
      }

      const slug = match[1] as string;

      const sandbox = await resolveSandbox(slug, {
        slots: opts.slots,
        store: opts.store,
        storage: opts.storage,
      });

      if (!sandbox) {
        socket.destroy();
        return;
      }

      const resumeFrom = url.searchParams.get("sessionId") ?? undefined;
      const skipGreeting = url.searchParams.has("resume") || resumeFrom !== undefined;
      wss.handleUpgrade(req, socket, head, (ws) => {
        sandbox.startSession(ws, skipGreeting, resumeFrom);
      });
    } catch (err: unknown) {
      console.error("WebSocket upgrade error:", err);
      socket.destroy();
    }
  });

  console.info(`AAI server listening on http://localhost:${port}`);

  async function shutdown() {
    console.info("Shutting down...");
    wss.close();
    const stops = [...opts.slots.values()]
      .map((slot) => {
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        return slot.sandbox?.terminate();
      })
      .filter(Boolean);
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
