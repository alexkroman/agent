// Copyright 2025 the AAI authors. MIT license.

import { createUnstorageKv, type SessionWebSocket } from "@alexkroman1/aai/host";
import { MAX_WS_PAYLOAD_BYTES } from "@alexkroman1/aai/isolate";
import { KvRequestSchema } from "@alexkroman1/aai/protocol";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Storage } from "unstorage";
import { WebSocketServer } from "ws";
import { createConnectionTracker } from "./connection-tracker.ts";
import { agentKvPrefix, MAX_CONNECTIONS } from "./constants.ts";
import type { Env } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { handleDeploy, handleDeployNew } from "./deploy.ts";
import { createErrorHandler } from "./error-handler.ts";
import { handleKv } from "./kv-handler.ts";
import { authMw, ownerMw, slugMw, validateSlug } from "./middleware.ts";
import type { AgentSlot } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox.ts";
import { DeployBodySchema, SecretUpdatesSchema } from "./schemas.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import type { BundleStore } from "./store-types.ts";
import { handleAgentHealth, handleAgentPage, handleClientAsset } from "./transport-websocket.ts";

export type OrchestratorOpts = {
  slots: Map<string, AgentSlot>;
  store: BundleStore;
  storage: Storage;
  /** Allowed CORS origins. Defaults to `["*"]` (any origin). */
  allowedOrigins?: string[];
};

export type Orchestrator = {
  app: Hono<Env>;
  injectWebSocket: (server: import("node:http").Server) => void;
};

export function createOrchestrator(opts: OrchestratorOpts): Orchestrator {
  const app = new Hono<Env>();

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

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Top-level deploy — slug is optional in body, server generates one if missing
  app.post("/deploy", authMw, zValidator("json", DeployBodySchema), handleDeployNew);

  // Bare-slug redirect (before sub-router so it takes priority)
  app.get("/:slug{[a-z0-9][a-z0-9_-]*[a-z0-9]}", (c) => {
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), 301);
  });

  // ── Slug-scoped sub-router ──────────────────────────────────────────
  const agents = new Hono<Env>();
  agents.use("*", slugMw);

  // Owner-protected routes — request bodies validated by zValidator before handlers
  agents.post("/deploy", ownerMw, zValidator("json", DeployBodySchema), handleDeploy);
  agents.delete("/", ownerMw, handleDelete);
  agents.get("/secret", ownerMw, handleSecretList);
  agents.put("/secret", ownerMw, zValidator("json", SecretUpdatesSchema), handleSecretSet);
  agents.delete("/secret/:key", ownerMw, handleSecretDelete);
  agents.post("/kv", ownerMw, zValidator("json", KvRequestSchema), handleKv);
  agents.get("/kv", ownerMw, async (c) => {
    const key = c.req.query("key");
    if (!key) return c.json({ error: "Missing key query parameter" }, 400);
    const slug = c.var.slug;
    const manifest = await c.env.store.getManifest(slug);
    if (!manifest) return c.json(null, 404);
    const kv = createUnstorageKv({ storage: c.env.storage, prefix: agentKvPrefix(slug) });
    const value = await kv.get(key);
    if (value === null) return c.json(null, 404);
    return c.json(value);
  });

  // Public routes
  agents.get("/health", handleAgentHealth);
  agents.get("/assets/:path{.+}", handleClientAsset);
  // Agent page (GET /:slug/) stays on top-level app because Hono's
  // mergePath("/:slug", "/") collapses the trailing slash.
  app.route("/:slug", agents);
  app.get("/:slug/", slugMw, handleAgentPage);

  // Bindings injected at serve time via app.fetch(req, bindings)
  const bindings = {
    slots: opts.slots,
    store: opts.store,
    storage: opts.storage,
  };

  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });

  // WebSocket upgrade — URL pattern: /:slug/websocket
  const connections = createConnectionTracker(MAX_CONNECTIONS);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  const SLUG_WS_RE = /^\/([a-z0-9][a-z0-9_-]*[a-z0-9])\/websocket$/;

  /** Parse the upgrade URL and resolve the matching sandbox (or null). */
  async function resolveUpgrade(rawUrl: string) {
    const url = new URL(rawUrl, "http://localhost");
    const match = url.pathname.match(SLUG_WS_RE);
    if (!match) return null;
    const slug = validateSlug(match[1] as string);
    const sandbox = await resolveSandbox(slug, {
      slots: opts.slots,
      store: opts.store,
      storage: opts.storage,
    });
    return sandbox ? { sandbox, url } : null;
  }

  const injectWebSocket = (server: import("node:http").Server) => {
    server.on("upgrade", async (req, socket, head) => {
      const pathOnly = req.url?.split("?")[0] ?? "";
      if (!SLUG_WS_RE.test(pathOnly)) return;

      if (!connections.tryAcquire()) {
        console.warn("WebSocket connection limit reached, rejecting upgrade");
        socket.destroy();
        return;
      }

      try {
        const result = await resolveUpgrade(req.url ?? "/");
        if (!result) {
          connections.release();
          socket.destroy();
          return;
        }
        const { sandbox, url } = result;
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("close", () => connections.release());
          const resumeFrom = url.searchParams.get("sessionId") ?? undefined;
          const skipGreeting = url.searchParams.has("resume") || resumeFrom !== undefined;
          sandbox.startSession(ws as unknown as SessionWebSocket, {
            skipGreeting,
            ...(resumeFrom ? { resumeFrom } : {}),
          });
        });
      } catch (err: unknown) {
        connections.release();
        console.error("WebSocket open error:", err);
        socket.destroy();
      }
    });
  };

  return { app, injectWebSocket };
}
