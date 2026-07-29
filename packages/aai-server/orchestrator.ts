// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP + WebSocket routing for the managed platform server.
 *
 * Route structure:
 * - `GET  /`                      — browser studio (coding agent UI)
 * - `GET  /health`                — platform health check
 * - `/studio/*`                   — studio API (see studio/studio-routes.ts)
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
import { gzipRequestMw } from "./gzip-request.ts";
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
import { createStudioRoutes } from "./studio/studio-routes.ts";
import { handleStudioClientAsset, handleStudioPage } from "./studio/studio-static.ts";
import { handleAgentHealth, handleAgentPage, handleClientAsset } from "./transport-websocket.ts";
import { handleVector } from "./vector-handler.ts";
import { guardHostModeUpgrade, startDeployedHostSession, wantsHostMode } from "./ws-host-mode.ts";

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
      // SAMEORIGIN (not DENY) so the studio's live preview can iframe agent
      // pages. Cross-origin framing (real clickjacking) stays blocked;
      // same-origin tenants can already script against each other's public
      // pages, so this does not widen the tenant boundary.
      xFrameOptions: "SAMEORIGIN",
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

  // Browser studio: loading the server root gives a coding agent that can
  // build and deploy voice agents from the browser. `studio` and
  // `studio-assets` are reserved slugs (RESERVED_SLUGS) so no agent route
  // can shadow the API namespace or the client assets.
  app.get("/", handleStudioPage);
  app.get("/studio-assets/:path{.+}", handleStudioClientAsset);
  app.route("/studio", createStudioRoutes({ pool: opts.pool }));
  app.get("/studio/", (c) => c.redirect("/", 302));

  app.post("/deploy", authMw, gzipRequestMw, zValidator("json", DeployBodySchema), handleDeployNew);

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
  agents.post(
    "/deploy",
    ownerMw,
    gzipRequestMw,
    zValidator("json", DeployBodySchema),
    handleDeploy,
  );
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
    return { sandbox, mode, agentConfig };
  }

  /**
   * Take a connection slot for this upgrade and wire its single release point.
   * Returns false (and destroys the socket) when the server is at capacity.
   *
   * The raw socket's `close` fires in every outcome — client abort during the
   * async resolve (where handleUpgrade would otherwise destroy the socket
   * without invoking its callback, leaking the slot forever), a failed
   * upgrade, or a normal session end — so it is the one reliable place to
   * release.
   */
  function acquireConnectionSlot(socket: { destroy: () => void; on: Function }): boolean {
    if (!connections.tryAcquire()) {
      console.warn("WebSocket connection limit reached, rejecting upgrade");
      socket.destroy();
      return false;
    }
    let released = false;
    socket.on("close", () => {
      if (released) return;
      released = true;
      connections.release();
    });
    return true;
  }

  /**
   * Resolve the agent and hand the socket to the session, or destroy it.
   * Split out of the upgrade handler so each stays under the complexity cap.
   */
  async function completeUpgrade(
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
    ctx: { slug: string; rawUrl: string; hostMode: boolean },
  ): Promise<void> {
    const { slug, rawUrl, hostMode } = ctx;
    try {
      const result = await resolveUpgrade(slug);
      if (!result) {
        socket.destroy();
        return;
      }
      const { sandbox, mode, agentConfig } = result;
      wss.handleUpgrade(req, socket, head, (ws) => {
        onSessionSocket(ws as unknown as SessionWebSocket, {
          slug,
          mode,
          sandbox,
          agentConfig,
          hostMode,
          rawUrl,
        });
      });
    } catch (err: unknown) {
      console.error("WebSocket open error:", err);
      socket.destroy();
    }
  }

  /**
   * Wire metrics and start the session once the socket is upgraded. Extracted
   * from the upgrade handler so neither piece trips the complexity cap.
   */
  function onSessionSocket(
    ws: SessionWebSocket,
    ctx: {
      slug: string;
      mode: SessionMode;
      sandbox: Awaited<ReturnType<typeof resolveSandbox>>;
      agentConfig: IsolateConfig | null;
      hostMode: boolean;
      rawUrl: string;
    },
  ): void {
    const { slug, mode, sandbox, agentConfig, hostMode, rawUrl } = ctx;
    metrics.sessionsStarted.inc({ slug, mode });
    metrics.sessionsActive.inc({ slug });
    // Track the live session so idle eviction can't kill the sandbox mid-call
    // (a session can outlive IDLE_SANDBOX_MS).
    acquireSlotSession(opts.slots, slug);
    const startedAt = process.hrtime.bigint();
    const socket = ws as unknown as {
      on: (event: string, fn: (arg: number) => void) => void;
    };
    socket.on("close", (code: number) => {
      releaseSlotSession(opts.slots, slug);
      metrics.sessionDuration.observe(hrtimeSeconds(startedAt));
      metrics.sessionsActive.dec({ slug });
      const reason: SessionEndReason =
        code === 1000 || code === 1001 ? "client_close" : "server_close";
      metrics.sessionsEnded.inc({ slug, reason });
    });
    socket.on("error", () => {
      const kind: SessionErrorKind = "internal";
      metrics.sessionErrors.inc({ kind });
    });
    if (hostMode && agentConfig) {
      startDeployedHostSession(ws, {
        slug,
        agentConfig,
        store: opts.store,
        startOpts: parseWsUpgradeParams(rawUrl),
      });
      return;
    }
    sandbox?.startSession(ws, parseWsUpgradeParams(rawUrl));
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

      const rawUrl = req.url ?? "";
      const pathOnly = rawUrl.split("?")[0] ?? "";
      const slugMatch = pathOnly.match(SLUG_WS_RE);
      if (!slugMatch) {
        // No other upgrade consumer exists on this server: an unmatched
        // upgrade socket would otherwise dangle forever.
        socket.destroy();
        return;
      }
      const slug = slugMatch[1] as string;

      if (!acquireConnectionSlot(socket)) return;

      // Host mode lets the caller replace the agent's prompt and tools, so it
      // requires proving ownership of the slug — unlike a plain connection,
      // which stays unauthenticated. The guard answers and closes the socket
      // itself when it refuses. See ws-host-mode.ts.
      const hostMode = wantsHostMode(rawUrl);
      const mayProceed = await guardHostModeUpgrade({
        rawUrl,
        slug,
        headers: req.headers,
        store: opts.store,
        socket,
      });
      if (!mayProceed) return;

      await completeUpgrade(req, socket, head, { slug, rawUrl, hostMode });
    });
  };

  return { app, injectWebSocket };
}
