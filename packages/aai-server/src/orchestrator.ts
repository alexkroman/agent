// Copyright 2025 the AAI authors. MIT license.

import { createUnstorageKv, type SessionWebSocket } from "@alexkroman1/aai/internal";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Storage } from "unstorage";
import type { BundleStore } from "./bundle-store.ts";
import type { Env } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { handleDeploy } from "./deploy.ts";
import { createErrorHandler } from "./error-handler.ts";
import { factory } from "./factory.ts";
import { handleKv } from "./kv-handler.ts";
import { requireOwner, validateSlug } from "./middleware.ts";
import type { AgentSlot } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
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

  const slugMw = factory.createMiddleware(async (c, next) => {
    // biome-ignore lint/style/noNonNullAssertion: slug param guaranteed by route pattern
    c.set("slug", validateSlug(c.req.param("slug")!));
    await next();
  });

  const ownerMw = factory.createMiddleware(async (c, next) => {
    const keyHash = await requireOwner(c.req.raw, {
      slug: c.var.slug,
      store: c.env.store,
    });
    c.set("keyHash", keyHash);
    await next();
  });

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

  // Bare-slug redirect (before sub-router so it takes priority)
  app.get("/:slug{[a-z0-9][a-z0-9_-]*[a-z0-9]}", (c) => {
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), 301);
  });

  // ── Slug-scoped sub-router ──────────────────────────────────────────
  const agents = new Hono<Env>();
  agents.use("*", slugMw);

  // Owner-protected routes
  agents.post("/deploy", ownerMw, handleDeploy);
  agents.delete("/", ownerMw, handleDelete);
  agents.get("/secret", ownerMw, handleSecretList);
  agents.put("/secret", ownerMw, handleSecretSet);
  agents.delete("/secret/:key", ownerMw, handleSecretDelete);
  agents.post("/kv", ownerMw, handleKv);
  agents.get("/kv", ownerMw, async (c) => {
    const key = c.req.query("key");
    if (!key) return c.json({ error: "Missing key query parameter" }, 400);
    const slug = c.var.slug;
    const manifest = await c.env.store.getManifest(slug);
    if (!manifest) return c.json(null, 404);
    const kv = createUnstorageKv({ storage: c.env.storage, prefix: `agents/${slug}/kv` });
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
  const wss = new WebSocketServer({ noServer: true });

  const injectWebSocket = (server: import("node:http").Server) => {
    server.on("upgrade", async (req, socket, head) => {
      const pathOnly = req.url?.split("?")[0] ?? "";
      if (!/^\/[a-z0-9][a-z0-9_-]*[a-z0-9]\/websocket$/.test(pathOnly)) return;

      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]*[a-z0-9])\/websocket$/);
        if (!match) {
          socket.destroy();
          return;
        }
        const slug = validateSlug(match[1] as string);
        const sandbox = await resolveSandbox(slug, {
          slots: opts.slots,
          store: opts.store,
          storage: opts.storage,
        });
        if (!sandbox) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const resumeFrom = url.searchParams.get("sessionId") ?? undefined;
          const skipGreeting = url.searchParams.has("resume") || resumeFrom !== undefined;
          sandbox.startSession(ws as unknown as SessionWebSocket, {
            skipGreeting,
            ...(resumeFrom ? { resumeFrom } : {}),
          });
        });
      } catch (err: unknown) {
        console.error("WebSocket open error:", err);
        socket.destroy();
      }
    });
  };

  return { app, injectWebSocket };
}
