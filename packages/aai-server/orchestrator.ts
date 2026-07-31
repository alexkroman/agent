// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP + WebSocket routing for the managed platform server.
 *
 * Route structure:
 * - `GET  /`                      — browser studio (coding agent UI)
 * - `GET  /health`                — platform health check
 * - `GET  /favicon.ico`           — studio favicon
 * - `/studio/*`                   — studio API (see studio/studio-routes.ts)
 * - `POST /deploy`                — top-level deploy (server-generated slug)
 * - `GET  /:slug`                 — redirect to /:slug/
 * - `GET  /:slug/`               — agent UI page
 * - `GET  /:slug/health`         — per-agent health check
 * - `GET  /:slug/client-config`  — pre-connection client config (name/greeting)
 * - `GET  /:slug/favicon.ico`    — agent page favicon (custom or default)
 * - `GET  /:slug/assets/:path`   — client static assets
 * - `DELETE /:slug/`             — owner: delete agent
 * - `GET/PUT/DELETE /:slug/secret` — owner: manage secrets
 * - `GET/POST/DELETE /:slug/storage` — owner: per-app database storage
 * - `POST /:slug/vector`         — owner: Vector store operations
 * - `WS   /:slug/websocket`     — WebSocket upgrade for voice sessions
 *
 * Auth: `authMw` validates API key; `existingOwnerMw` verifies slug ownership.
 * Slugs: `[a-z0-9][a-z0-9_-]*[a-z0-9]` — enforced by regex for multi-tenant isolation.
 */

import { VectorRequestSchema } from "@alexkroman1/aai/protocol";
import type { Vector } from "@alexkroman1/aai/runtime";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppDatabases } from "./app-database.ts";
import { handleAgentClientConfig } from "./client-config-handler.ts";
import { resolveHarnessPath } from "./constants.ts";
import type { AppContext, HonoEnv } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { type BundleInspector, handleDeployNew } from "./deploy.ts";
import { createErrorHandler } from "./error-handler.ts";
import { gzipRequestMw, MAX_INFLATED_BODY_BYTES } from "./gzip-request.ts";
import { authMw, existingOwnerMw, slugMw } from "./middleware.ts";
import { createWsUpgrades } from "./orchestrator-ws.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { resolveAgentVector } from "./sandbox.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import type { SlotCache } from "./sandbox-slots.ts";
import { describeBundle } from "./sandbox-vm.ts";
import { DeployBodySchema, SecretUpdatesSchema, VALID_SLUG_RE } from "./schemas.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import {
  handleStorageDisable,
  handleStorageEnable,
  handleStorageStatus,
} from "./storage-handler.ts";
import type { BundleStore } from "./store-types.ts";
import type { ChatStore } from "./studio/chat-store.ts";
import { createStudioRoutes } from "./studio/studio-routes.ts";
import {
  handleStudioClientAsset,
  handleStudioFavicon,
  handleStudioPage,
} from "./studio/studio-static.ts";
import type { WorkspaceStore } from "./studio/workspace-store.ts";
import {
  handleAgentFavicon,
  handleAgentHealth,
  handleAgentPage,
  handleClientAsset,
} from "./transport-websocket.ts";
import { handleVector } from "./vector-handler.ts";

export type OrchestratorOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Studio project workspaces (Postgres in production, memory in dev/tests). */
  workspaces: WorkspaceStore;
  /** Studio project chat histories (Postgres in production, memory in dev/tests). */
  chats: ChatStore;
  /** Named secret storage (Supabase Vault in production, memory in tests). */
  secrets?: SecretStore;
  /** Per-app database provisioning; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  /** Factory that creates the server-default Vector for a given slug. */
  defaultVector: (slug: string) => Vector;
  /** Allowed CORS origins. Defaults to `["*"]` (any origin). */
  allowedOrigins?: string[];
  /** Optional pre-warmed Deno harness pool for faster cold starts. */
  pool?: SandboxPool;
  /**
   * Extracts an agent config from an uploaded worker bundle. Defaults to
   * sandboxed `describeBundle`; injectable so tests don't need Modal.
   */
  inspect?: BundleInspector;
  /** Max concurrent WebSocket connections. Defaults to MAX_CONNECTIONS. */
  maxConnections?: number;
  /**
   * True once shutdown has begun. Fails `/health` and refuses new WebSocket
   * upgrades so the machine stops taking sessions it is about to drop.
   */
  isDraining?: () => boolean;
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

export type Orchestrator = {
  app: Hono<HonoEnv>;
  injectWebSocket: (server: import("node:http").Server) => void;
  /**
   * Close every live session WebSocket (1001 "going away"). Graceful
   * shutdown calls this after the drain deadline — an HTTP server with open
   * WebSockets never finishes closing on its own.
   */
  closeActiveSockets: () => void;
  /** Live session sockets. Shutdown polls this while draining. */
  activeSessionCount: () => number;
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

  // 503 while draining is what pulls the replica out of the platform
  // proxy's rotation, so new traffic goes to a replica that is staying up.
  // Without it the drain would keep accepting the very sessions it is
  // waiting to finish.
  app.get("/health", (c) =>
    opts.isDraining?.() ? c.json({ status: "draining" }, 503) : c.json({ status: "ok" }),
  );

  // Browser studio: loading the server root gives a coding agent that can
  // build and deploy voice agents from the browser. `studio` and
  // `studio-assets` are reserved slugs (RESERVED_SLUGS) so no agent route
  // can shadow the API namespace or the client assets.
  app.get("/", handleStudioPage);
  // Safe alongside agent routes: `favicon.ico` can never be a slug (dots
  // are outside the slug grammar), so no agent route can shadow it.
  app.get("/favicon.ico", handleStudioFavicon);
  app.get("/studio-assets/:path{.+}", handleStudioClientAsset);
  app.route("/studio", createStudioRoutes({ pool: opts.pool }));
  app.get("/studio/", (c) => c.redirect("/", 302));

  // Cap the on-the-wire deploy body (compressed or not) before anything
  // buffers it. gzipRequestMw separately caps the DECOMPRESSED size, so a
  // zip bomb is bounded on both axes.
  const deployBodyLimit = bodyLimit({
    maxSize: MAX_INFLATED_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });

  // Config extraction loads the uploaded worker in a throwaway guest
  // sandbox and reads its `__aaiConfig` self-description — tenant code
  // never runs on the host.
  const inspect: BundleInspector =
    opts.inspect ??
    ((workerCode) =>
      describeBundle({ harnessPath: resolveHarnessPath(), workerCode, pool: opts.pool }));

  app.post(
    "/deploy",
    authMw,
    deployBodyLimit,
    gzipRequestMw,
    zValidator("json", DeployBodySchema),
    (c) => handleDeployNew(c, inspect),
  );

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

  // Deploys go through the top-level `POST /deploy` (slug in the body). Every
  // owner-scoped route here operates on an existing agent's data/secrets and
  // uses existingOwnerMw, which rejects unclaimed slugs.
  agents.delete("/", existingOwnerMw, handleDelete);
  agents.get("/secret", existingOwnerMw, handleSecretList);
  agents.put("/secret", existingOwnerMw, zValidator("json", SecretUpdatesSchema), handleSecretSet);
  agents.delete("/secret/:key", existingOwnerMw, handleSecretDelete);
  // Per-app database storage — same auth posture as the secret routes.
  agents.get("/storage", existingOwnerMw, handleStorageStatus);
  agents.post("/storage", existingOwnerMw, handleStorageEnable);
  agents.delete("/storage", existingOwnerMw, handleStorageDisable);
  agents.post("/vector", existingOwnerMw, zValidator("json", VectorRequestSchema), async (c) => {
    const slug = c.var.slug;
    const { agentConfig, env } = await loadAgentConfig(c, slug);
    if (!agentConfig) return c.json({ error: "agent not configured" }, 404);
    return handleVector(c, resolveAgentVector(slug, agentConfig, env, c.env.defaultVector));
  });

  agents.get("/health", handleAgentHealth);
  // Pre-connection client config (name/greeting) for the default
  // client — same auth posture as the page and the WebSocket: none.
  agents.get("/client-config", handleAgentClientConfig);
  agents.get("/favicon.ico", handleAgentFavicon);
  agents.get("/assets/:path{.+}", handleClientAsset);
  // GET /:slug/ stays on the top-level app — Hono's mergePath("/:slug", "/")
  // collapses the trailing slash, breaking the route.
  app.route("/:slug", agents);
  app.get("/:slug/", slugMw, handleAgentPage);

  const bindings = {
    slots: opts.slots,
    store: opts.store,
    workspaces: opts.workspaces,
    chats: opts.chats,
    // Tests build orchestrators without a secret store; default to memory so
    // the storage-status route (and anything else reading secrets) works.
    secrets: opts.secrets ?? createMemorySecretStore(),
    ...(opts.appDb && { appDb: opts.appDb }),
    defaultVector: opts.defaultVector,
  };
  // resolveSandbox takes the bindings minus the studio stores (bundle data
  // lives in the BundleStore; `workspaces`/`chats` are studio-only).
  const { workspaces: _studioWorkspaces, chats: _studioChats, ...sandboxBindings } = bindings;
  const sandboxOpts = { ...sandboxBindings, ...(opts.pool && { pool: opts.pool }) };

  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });

  const { injectWebSocket, closeActiveSockets, activeSessionCount } = createWsUpgrades({
    slots: opts.slots,
    store: opts.store,
    sandboxOpts,
    ...(opts.maxConnections !== undefined && { maxConnections: opts.maxConnections }),
    ...(opts.isDraining && { isDraining: opts.isDraining }),
  });

  return { app, injectWebSocket, closeActiveSockets, activeSessionCount };
}
