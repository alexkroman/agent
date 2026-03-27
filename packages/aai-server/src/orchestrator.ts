// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai/utils";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Storage } from "unstorage";
import { z } from "zod";
import type { BundleStore } from "./bundle-store.ts";
import type { Env } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { handleDeploy } from "./deploy.ts";
import { handleKv } from "./kv-handler.ts";
import { serialize, serializeForAgent } from "./metrics.ts";
import { requireInternal, requireOwner, validateSlug } from "./middleware.ts";
import type { AgentSlot } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox.ts";
import { createScopedKv } from "./scoped-storage.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import { handleAgentHealth, handleAgentPage, handleClientAsset } from "./transport-websocket.ts";
import { handleVector } from "./vector-handler.ts";

export type OrchestratorOpts = {
  slots: Map<string, AgentSlot>;
  store: BundleStore;
  storage: Storage;
  /** Allowed CORS origins. Defaults to `["*"]` (any origin). */
  allowedOrigins?: string[];
  /** Directory for caching embedding models. Defaults to `.aai/models`. */
  modelCacheDir?: string;
};

export type Orchestrator = {
  app: Hono<Env>;
  injectWebSocket: (server: import("node:http").Server) => void;
};

export function createOrchestrator(opts: OrchestratorOpts): Orchestrator {
  const app = new Hono<Env>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const slugMw = createMiddleware<Env>(async (c, next) => {
    // biome-ignore lint/style/noNonNullAssertion: slug param guaranteed by route pattern
    c.set("slug", validateSlug(c.req.param("slug")!));
    await next();
  });

  const ownerMw = createMiddleware<Env>(async (c, next) => {
    const keyHash = await requireOwner(c.req.raw, {
      slug: c.get("slug"),
      store: c.env.store,
    });
    c.set("keyHash", keyHash);
    await next();
  });

  const internalMw = createMiddleware<Env>(async (c, next) => {
    requireInternal(c.req.raw);
    await next();
  });

  // WebSocket route must be registered before CORS/secureHeaders middleware
  // to avoid the "immutable headers" error that breaks WebSocket upgrades.
  app.get(
    "/:slug/websocket",
    slugMw,
    upgradeWebSocket((c) => {
      const slug = c.get("slug");
      return {
        async onOpen(_evt, ws) {
          try {
            const sandbox = await resolveSandbox(slug, {
              slots: opts.slots,
              store: opts.store,
              storage: opts.storage,
            });
            if (!sandbox) {
              ws.close(1008, "Agent not found");
              return;
            }
            const resumeFrom = c.req.query("sessionId") ?? undefined;
            const skipGreeting = c.req.query("resume") !== undefined || resumeFrom !== undefined;
            if (ws.raw) sandbox.startSession(ws.raw, skipGreeting, resumeFrom);
          } catch (err: unknown) {
            console.error("WebSocket open error:", err);
            ws.close(1011, "Internal error");
          }
        },
      };
    }),
  );

  // Skip CORS and secureHeaders for WebSocket upgrades — these middleware
  // modify response headers, which breaks the immutable upgrade response.
  const isWsUpgrade = (c: { req: { header: (k: string) => string | undefined } }) =>
    c.req.header("upgrade")?.toLowerCase() === "websocket";

  const allowedOrigins = opts.allowedOrigins;
  const corsMw = cors({
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
  });
  app.use("*", (c, next) => (isWsUpgrade(c) ? next() : corsMw(c, next)));

  const secureMw = secureHeaders({
    crossOriginOpenerPolicy: "same-origin",
    crossOriginEmbedderPolicy: "credentialless",
    crossOriginResourcePolicy: "same-origin",
    xContentTypeOptions: "nosniff",
    xFrameOptions: "DENY",
  });
  app.use("*", (c, next) => (isWsUpgrade(c) ? next() : secureMw(c, next)));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError || err instanceof SyntaxError) {
      return c.json({ error: err.message }, 400);
    }
    const errMsg = errorMessage(err);
    const stack = err instanceof Error ? err.stack : "";
    const path = new URL(c.req.url).pathname;
    console.error(`Unhandled error on ${path}: ${errMsg}\n${stack}`);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/metrics", internalMw, async (c) =>
    c.text(await serialize(), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    }),
  );

  app.get("/:slug{[a-z0-9][a-z0-9_-]*[a-z0-9]}", (c) => {
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), 301);
  });

  app.post("/:slug/deploy", slugMw, ownerMw, handleDeploy);
  app.delete("/:slug", slugMw, ownerMw, handleDelete);
  app.get("/:slug/secret", slugMw, ownerMw, handleSecretList);
  app.put("/:slug/secret", slugMw, ownerMw, handleSecretSet);
  app.delete("/:slug/secret/:key", slugMw, ownerMw, handleSecretDelete);
  app.post("/:slug/kv", slugMw, ownerMw, handleKv);
  app.post("/:slug/vector", slugMw, ownerMw, handleVector);

  app.get("/:slug/metrics", slugMw, ownerMw, async (c) =>
    c.text(await serializeForAgent(c.get("slug")), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    }),
  );

  app.get("/:slug/health", slugMw, handleAgentHealth);
  app.get("/:slug/assets/:path{.+}", slugMw, handleClientAsset);

  app.get("/:slug/kv", slugMw, ownerMw, async (c) => {
    const key = c.req.query("key");
    if (!key) return c.json({ error: "Missing key query parameter" }, 400);
    const slug = c.get("slug");
    const manifest = await c.env.store.getManifest(slug);
    if (!manifest) return c.json(null, 404);
    const kv = createScopedKv(c.env.storage, slug);
    const value = await kv.get(key);
    if (value === null) return c.json(null, 404);
    return c.json(value);
  });

  app.get("/:slug/", slugMw, handleAgentPage);

  // Bindings injected at serve time via app.fetch(req, bindings)
  const bindings = {
    slots: opts.slots,
    store: opts.store,
    storage: opts.storage,
    modelCacheDir: opts.modelCacheDir,
  };

  // Use Object.assign to mutate the caller's env rather than spreading into
  // a new object. @hono/node-ws's injectWebSocket passes an env object and
  // reads a symbol back from it after app.request() — spreading would break
  // that reference and prevent WebSocket upgrades from completing.
  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, Object.assign(env ?? {}, bindings));

  return { app, injectWebSocket };
}
