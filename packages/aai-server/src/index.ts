// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI platform server.
 *
 * Creates the Hono orchestrator backed by Upstash/Tigris services and starts
 * a Node.js HTTP server with WebSocket upgrade support via `ws`.
 */

import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createBundleStore, createS3Client } from "./bundle-store-tigris.ts";
import { deriveCredentialKey } from "./credentials.ts";
import { createKvStore } from "./kv.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import type { AgentSlot } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox.ts";
import { importScopeKey, verifyScopeToken } from "./scope-token.ts";
import { createVectorStore } from "./vector.ts";

function resolveVectorUrl(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  let url = env.UPSTASH_VECTOR_REST_URL ?? env.VECTOR_ENDPOINT;
  const token = env.UPSTASH_VECTOR_REST_TOKEN ?? env.VECTOR_TOKEN;
  if (!(url && token)) return null;
  if (!url.startsWith("http")) url = `http://${url}`;
  return { url, token };
}

async function buildOpts(env: NodeJS.ProcessEnv): Promise<OrchestratorOpts> {
  const bucket = env.BUCKET_NAME;
  const kvSecret = env.KV_SCOPE_SECRET;
  if (!(bucket && kvSecret)) {
    throw new Error("BUCKET_NAME and KV_SCOPE_SECRET must be set");
  }

  const credentialKey = await deriveCredentialKey(kvSecret);
  const s3 = createS3Client({
    ...(env.AWS_ENDPOINT_URL_S3 ? { AWS_ENDPOINT_URL_S3: env.AWS_ENDPOINT_URL_S3 } : {}),
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID ?? "",
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ?? "",
  });
  const store = createBundleStore(s3, { bucket, credentialKey });
  const kvStore = createKvStore(
    env.UPSTASH_REDIS_REST_URL ?? "",
    env.UPSTASH_REDIS_REST_TOKEN ?? "",
  );

  const vec = resolveVectorUrl(env);
  const vectorStore = vec ? createVectorStore(vec.url, vec.token) : undefined;
  const scopeKey = await importScopeKey(kvSecret);

  return {
    slots: new Map<string, AgentSlot>(),
    store,
    kvStore,
    vectorStore,
    scopeKey,
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

      // Require a valid scope token for WebSocket connections.
      const token = url.searchParams.get("token");
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const scope = await verifyScopeToken(opts.scopeKey, token);
      if (!scope || scope.slug !== slug) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const sandbox = await resolveSandbox(slug, {
        slots: opts.slots,
        store: opts.store,
        kvStore: opts.kvStore,
        vectorStore: opts.vectorStore,
      });

      if (!sandbox) {
        socket.destroy();
        return;
      }

      const resume = url.searchParams.has("resume");
      wss.handleUpgrade(req, socket, head, (ws) => {
        sandbox.startSession(ws, resume);
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
    // Await all sandbox terminations before closing the server.
    await Promise.allSettled(stops);
    nodeServer.close(() => process.exit(0));
    // Force exit if cleanup takes too long
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
