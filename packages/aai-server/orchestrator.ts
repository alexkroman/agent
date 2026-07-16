// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP + WebSocket routing for the managed platform server.
 *
 * Route structure:
 * - `GET  /health`                — platform health check
 * - `POST /deploy`                — top-level deploy (server-generated slug)
 * - `GET  /:slug`                 — redirect to /:slug/
 * - `GET  /:slug/`               — agent UI page
 * - `GET  /:slug/health`         — per-agent health check
 * - `GET  /:slug/assets/:path`   — client static assets
 * - `POST /:slug/deploy`         — owner: re-deploy agent
 * - `DELETE /:slug/`             — owner: delete agent
 * - `GET/PUT/DELETE /:slug/secret` — owner: manage secrets
 * - `GET/POST /:slug/kv`        — owner: KV store operations
 * - `POST /:slug/vector`         — owner: Vector store operations
 * - `WS   /:slug/websocket`     — WebSocket upgrade for voice sessions
 *
 * Auth: `authMw` validates API key; `ownerMw` verifies slug ownership.
 * Slugs: `[a-z0-9][a-z0-9_-]*[a-z0-9]` — enforced by regex for multi-tenant isolation.
 */

import { MAX_WS_PAYLOAD_BYTES, parseWsUpgradeParams } from "@alexkroman1/aai";
import { KvRequestSchema, VectorRequestSchema } from "@alexkroman1/aai/protocol";
import type { SessionWebSocket, Vector } from "@alexkroman1/aai/runtime";
import { prometheus } from "@hono/prometheus";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Storage } from "unstorage";
import { WebSocketServer } from "ws";
import { createConnectionTracker } from "./connection-tracker.ts";
import { MAX_CONNECTIONS } from "./constants.ts";
import type { AppContext, HonoEnv } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { handleDeploy, handleDeployNew } from "./deploy.ts";
import { createErrorHandler } from "./error-handler.ts";
import { handleKv } from "./kv-handler.ts";
import {
  hrtimeSeconds,
  metrics,
  registry,
  type SessionEndReason,
  type SessionErrorKind,
  type SessionMode,
  serialize,
} from "./metrics.ts";
import { authMw, existingOwnerMw, ownerMw, slugMw } from "./middleware.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { resolveAgentKv, resolveAgentVector, resolveSandbox } from "./sandbox.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { acquireSlotSession, releaseSlotSession, type SlotCache } from "./sandbox-slots.ts";
import { DeployBodySchema, SecretUpdatesSchema, VALID_SLUG_RE } from "./schemas.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import type { BundleStore } from "./store-types.ts";
import { handleAgentHealth, handleAgentPage, handleClientAsset } from "./transport-websocket.ts";
import { handleVector } from "./vector-handler.ts";

export type OrchestratorOpts = {
  slots: SlotCache;
  store: BundleStore;
  storage: Storage;
  /** Factory that creates the server-default Vector for a given slug. */
  defaultVector: (slug: string) => Vector;
  /** Allowed CORS origins. Defaults to `["*"]` (any origin). */
  allowedOrigins?: string[];
  /** Optional pre-warmed Deno harness pool for faster cold starts. */
  pool?: SandboxPool;
};

async function loadAgentConfig(
  c: AppContext,
  slug: string,
): Promise<{ agentConfig: IsolateConfig | null; env: Record<string, string> }> {
  const [agentConfig, agentEnv] = await Promise.all([
    c.env.store.getAgentConfig(slug),
    c.env.store.getEnv(slug),
  ]);
  return { agentConfig, env: agentEnv ?? {} };
}

// Build the prometheus middleware once at module load. `@hono/prometheus`
// constructs `http_requests_total` / `http_request_duration_seconds` on
// the registry every call, so calling it from `createOrchestrator` would
// throw "metric already registered" on the second invocation (e.g. during
// tests).
const { registerMetrics: prometheusMiddleware } = prometheus({ registry });

export type Orchestrator = {
  app: Hono<HonoEnv>;
  injectWebSocket: (server: import("node:http").Server) => void;
};

export function createOrchestrator(opts: OrchestratorOpts): Orchestrator {
  const app = new Hono<HonoEnv>();

  const allowedOrigins = opts.allowedOrigins;
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return "*"; // same-origin
        if (!allowedOrigins) return ""; // reject when no origins configured
        if (allowedOrigins.includes("*")) return "*";
        return allowedOrigins.includes(origin) ? origin : "";
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: false,
      maxAge: 86_400,
    }),
  );
  app.use(
    "*",
    secureHeaders({
      crossOriginOpenerPolicy: "same-origin",
      crossOriginEmbedderPolicy: "credentialless",
      crossOriginResourcePolicy: "same-origin",
      xContentTypeOptions: "nosniff",
      xFrameOptions: "DENY",
    }),
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError(createErrorHandler());
  app.use("*", prometheusMiddleware);

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Internal-only: Fly's private network doesn't add X-Forwarded-For;
  // public edge always does — treat XFF presence as "external request".
  app.get("/metrics", async (c) => {
    if (c.req.header("X-Forwarded-For")) return c.notFound();
    const text = await serialize();
    return c.text(text, 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  app.post("/deploy", authMw, zValidator("json", DeployBodySchema), handleDeployNew);

  // Bare-slug redirect — registered before sub-router so it takes priority.
  // Pattern derived from VALID_SLUG_RE (anchors stripped) so the slug
  // grammar has a single source of truth.
  app.get(`/:slug{${VALID_SLUG_RE.source.slice(1, -1)}}`, (c) => {
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), 301);
  });

  const agents = new Hono<HonoEnv>();
  agents.use("*", slugMw);

  // Deploy claims a new slug, so it uses ownerMw (unclaimed allowed). Every
  // other owner-scoped route operates on an existing agent's data/secrets and
  // uses existingOwnerMw, which rejects unclaimed slugs.
  agents.post("/deploy", ownerMw, zValidator("json", DeployBodySchema), handleDeploy);
  agents.delete("/", existingOwnerMw, handleDelete);
  agents.get("/secret", existingOwnerMw, handleSecretList);
  agents.put("/secret", existingOwnerMw, zValidator("json", SecretUpdatesSchema), handleSecretSet);
  agents.delete("/secret/:key", existingOwnerMw, handleSecretDelete);
  agents.post("/kv", existingOwnerMw, zValidator("json", KvRequestSchema), async (c) => {
    const { agentConfig, env } = await loadAgentConfig(c, c.var.slug);
    return handleKv(c, resolveAgentKv(c.env.storage, c.var.slug, agentConfig, env));
  });
  agents.get("/kv", existingOwnerMw, async (c) => {
    const key = c.req.query("key");
    if (!key) return c.json({ error: "Missing key query parameter" }, 400);
    const { agentConfig, env } = await loadAgentConfig(c, c.var.slug);
    if (!agentConfig) return c.json(null, 404);
    const value = await resolveAgentKv(c.env.storage, c.var.slug, agentConfig, env).get(key);
    if (value === null) return c.json(null, 404);
    return c.json(value);
  });
  agents.post("/vector", existingOwnerMw, zValidator("json", VectorRequestSchema), async (c) => {
    const slug = c.var.slug;
    const { agentConfig, env } = await loadAgentConfig(c, slug);
    return handleVector(c, resolveAgentVector(slug, agentConfig, env, c.env.defaultVector));
  });

  agents.get("/health", handleAgentHealth);
  agents.get("/assets/:path{.+}", handleClientAsset);
  // GET /:slug/ stays on the top-level app — Hono's mergePath("/:slug", "/")
  // collapses the trailing slash, breaking the route.
  app.route("/:slug", agents);
  app.get("/:slug/", slugMw, handleAgentPage);

  const bindings = {
    slots: opts.slots,
    store: opts.store,
    storage: opts.storage,
    defaultVector: opts.defaultVector,
  };
  const sandboxOpts = { ...bindings, ...(opts.pool && { pool: opts.pool }) };

  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });

  const connections = createConnectionTracker(MAX_CONNECTIONS);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  // Enforced here (not just in middleware) because WebSocket upgrades bypass
  // Hono routing. Derived from VALID_SLUG_RE (anchors stripped) so the slug
  // pattern has a single source of truth.
  const SLUG_WS_RE = new RegExp(`^\\/(${VALID_SLUG_RE.source.slice(1, -1)})\\/websocket$`);

  async function resolveUpgrade(slug: string) {
    const [sandbox, agentConfig] = await Promise.all([
      resolveSandbox(slug, sandboxOpts),
      opts.store.getAgentConfig(slug),
    ]);
    if (!sandbox) return null;
    const mode: SessionMode = agentConfig?.mode === "pipeline" ? "pipeline" : "s2s";
    return { sandbox, mode };
  }

  const injectWebSocket = (server: import("node:http").Server) => {
    server.on("upgrade", async (req, socket, head) => {
      // Node removes its own socket error listener before emitting `upgrade`;
      // without one, a client RST during the async resolve becomes an
      // unhandled `error` → uncaughtException → the whole host exits. Attach
      // before ANY early return so unmatched upgrade sockets are covered too.
      socket.on("error", () => {
        /* handled via close/destroy below; presence prevents an uncaught throw */
      });

      const pathOnly = req.url?.split("?")[0] ?? "";
      const slugMatch = pathOnly.match(SLUG_WS_RE);
      if (!slugMatch) {
        // No other upgrade consumer exists on this server: an unmatched
        // upgrade socket would otherwise dangle forever.
        socket.destroy();
        return;
      }
      const slug = slugMatch[1] as string;

      if (!connections.tryAcquire()) {
        console.warn("WebSocket connection limit reached, rejecting upgrade");
        socket.destroy();
        return;
      }

      // Release the slot exactly once. The raw socket's `close` fires in every
      // outcome — client abort during the async resolve below (where
      // handleUpgrade would otherwise destroy the socket without invoking its
      // callback, leaking the slot forever), a failed upgrade, or a normal
      // session end after upgrade — so it is the single reliable release point.
      let released = false;
      const releaseConn = () => {
        if (released) return;
        released = true;
        connections.release();
      };
      socket.on("close", releaseConn);

      try {
        const result = await resolveUpgrade(slug);
        if (!result) {
          socket.destroy();
          return;
        }
        const { sandbox, mode } = result;
        wss.handleUpgrade(req, socket, head, (ws) => {
          metrics.sessionsStarted.inc({ slug, mode });
          metrics.sessionsActive.inc({ slug });
          // Track the live session so idle eviction can't kill the sandbox
          // mid-call (a session can outlive IDLE_SANDBOX_MS).
          acquireSlotSession(opts.slots, slug);
          const startedAt = process.hrtime.bigint();
          ws.on("close", (code: number) => {
            releaseSlotSession(opts.slots, slug);
            metrics.sessionDuration.observe(hrtimeSeconds(startedAt));
            metrics.sessionsActive.dec({ slug });
            const reason: SessionEndReason =
              code === 1000 || code === 1001 ? "client_close" : "server_close";
            metrics.sessionsEnded.inc({ slug, reason });
          });
          ws.on("error", () => {
            const kind: SessionErrorKind = "internal";
            metrics.sessionErrors.inc({ kind });
          });
          sandbox.startSession(
            ws as unknown as SessionWebSocket,
            parseWsUpgradeParams(req.url ?? ""),
          );
        });
      } catch (err: unknown) {
        console.error("WebSocket open error:", err);
        socket.destroy();
      }
    });
  };

  return { app, injectWebSocket };
}
