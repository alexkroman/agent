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
import { ConnectionLimiter, RateLimiter } from "./rate-limit.ts";
import type { AgentSlot } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox.ts";
import { importScopeKey } from "./scope-token.ts";
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

  // ── WebSocket rate limiting ──────────────────────────────────────────
  // Max 50 concurrent sessions per slug (each spawns S2S + isolate memory).
  const wsSessionLimiter = new ConnectionLimiter(50);
  // Max 10 WebSocket connection attempts per IP per minute.
  const wsRateLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });

  nodeServer.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const match = SLUG_WS_RE.exec(url.pathname);
      if (!match) {
        socket.destroy();
        return;
      }

      // Per-IP rate limit on connection attempts
      const ip =
        req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        "unknown";
      if (!wsRateLimiter.consume(ip)) {
        socket.destroy();
        return;
      }

      const slug = match[1] as string;

      // Per-slug concurrent session limit
      if (!wsSessionLimiter.acquire(slug)) {
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
        wsSessionLimiter.release(slug);
        socket.destroy();
        return;
      }

      const resume = url.searchParams.has("resume");
      wss.handleUpgrade(req, socket, head, (ws) => {
        sandbox.startSession(ws, resume);
        ws.on("close", () => wsSessionLimiter.release(slug));
      });
    } catch (err) {
      console.error("WebSocket upgrade error:", err);
      socket.destroy();
    }
  });

  console.info(`AAI server listening on http://localhost:${port}`);

  function shutdown() {
    console.info("Shutting down...");
    wss.close();
    for (const slot of opts.slots.values()) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      slot.sandbox?.terminate();
    }
    nodeServer.close(() => process.exit(0));
    // Force exit if cleanup takes too long
    setTimeout(() => process.exit(1), 3000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
