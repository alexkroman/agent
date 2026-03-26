// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai/utils";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { BundleStore } from "./bundle-store-tigris.ts";
import type { Env } from "./context.ts";
import { handleDeploy } from "./deploy.ts";
import type { KvStore } from "./kv.ts";
import { handleKv } from "./kv-handler.ts";
import { serialize, serializeForAgent } from "./metrics.ts";
import { requireInternal, requireOwner, requireScopeToken, validateSlug } from "./middleware.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { AgentSlot } from "./sandbox.ts";
import type { ScopeKey } from "./scope-token.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import { handleAgentHealth, handleAgentPage, handleClientAsset } from "./transport-websocket.ts";
import type { ServerVectorStore } from "./vector.ts";
import { handleVector } from "./vector-handler.ts";

export type OrchestratorOpts = {
  slots: Map<string, AgentSlot>;
  store: BundleStore;
  kvStore: KvStore;
  vectorStore?: ServerVectorStore | undefined;
  scopeKey: ScopeKey;
  /** Override default rate-limit settings (primarily for testing). */
  rateLimits?: {
    deploy?: { maxRequests: number; windowMs: number };
    secret?: { maxRequests: number; windowMs: number };
  };
};

export function createOrchestrator(opts: OrchestratorOpts): Hono<Env> {
  const app = new Hono<Env>();

  // ── Rate limiters ────────────────────────────────────────────────────
  // Deploy: 10 deploys per minute per API-key hash (deploys are heavy –
  // each stores a 10 MB bundle and restarts the sandbox).
  const deployLimiter = new RateLimiter(
    opts.rateLimits?.deploy ?? { maxRequests: 10, windowMs: 60_000 },
  );
  // Secrets: 30 requests per minute per API-key hash.
  const secretLimiter = new RateLimiter(
    opts.rateLimits?.secret ?? { maxRequests: 30, windowMs: 60_000 },
  );

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
    c.set("scope", { keyHash, slug: c.get("slug") });
    await next();
  });

  /** Rate-limit middleware factory keyed on the authenticated keyHash. */
  const rateLimitMw = (limiter: RateLimiter) =>
    createMiddleware<Env>(async (c, next) => {
      const key = c.get("keyHash");
      if (!limiter.consume(key)) {
        throw new HTTPException(429, { message: "Too many requests" });
      }
      await next();
    });

  const internalMw = createMiddleware<Env>(async (c, next) => {
    requireInternal(c.req.raw);
    await next();
  });

  const scopeTokenMw = createMiddleware<Env>(async (c, next) => {
    c.set("scope", await requireScopeToken(c.req.raw, c.env.scopeKey));
    await next();
  });

  app.use(
    "*",
    cors({
      origin: (origin) => {
        // Allow same-origin requests (origin is null) and any origin for
        // agent pages (they are public-facing). Restrict credentials so
        // cookies/auth headers are not sent cross-origin by default.
        return origin ?? "*";
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

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError) {
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

  app.post("/:slug/deploy", slugMw, ownerMw, rateLimitMw(deployLimiter), handleDeploy);
  app.get("/:slug/secret", slugMw, ownerMw, rateLimitMw(secretLimiter), handleSecretList);
  app.put("/:slug/secret", slugMw, ownerMw, rateLimitMw(secretLimiter), handleSecretSet);
  app.delete("/:slug/secret/:key", slugMw, ownerMw, rateLimitMw(secretLimiter), handleSecretDelete);
  app.post("/:slug/kv", internalMw, slugMw, scopeTokenMw, handleKv);
  app.post("/:slug/vector", slugMw, ownerMw, handleVector);

  app.get("/:slug/metrics", slugMw, ownerMw, async (c) =>
    c.text(await serializeForAgent(c.get("slug")), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    }),
  );

  app.get("/:slug/health", slugMw, handleAgentHealth);
  app.get("/:slug/assets/:path{.+}", slugMw, handleClientAsset);
  app.get("/:slug/", slugMw, handleAgentPage);

  // Bindings injected at serve time via app.fetch(req, bindings)
  const bindings = {
    slots: opts.slots,
    store: opts.store,
    scopeKey: opts.scopeKey,
    kvStore: opts.kvStore,
    vectorStore: opts.vectorStore,
  };

  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });

  return app;
}
