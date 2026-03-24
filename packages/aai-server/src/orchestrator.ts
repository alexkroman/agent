// Copyright 2025 the AAI authors. MIT license.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { Env } from "./context.ts";
import { handleDeploy } from "./deploy.ts";
import type { KvStore } from "./kv.ts";
import { handleKv } from "./kv_handler.ts";
import { serializeForAgent } from "./metrics.ts";
import { requireInternal, requireOwner, requireScopeToken, validateSlug } from "./middleware.ts";
import type { AgentSlot } from "./sandbox.ts";
import type { ScopeKey } from "./scope_token.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret_handler.ts";
import { handleAgentHealth, handleAgentPage, handleClientAsset } from "./transport_websocket.ts";
import type { ServerVectorStore } from "./vector.ts";
import { handleVector } from "./vector_handler.ts";

export type OrchestratorOpts = {
  slots: Map<string, AgentSlot>;
  store: BundleStore;
  kvStore: KvStore;
  vectorStore?: ServerVectorStore | undefined;
  scopeKey: ScopeKey;
};

export function createOrchestrator(opts: OrchestratorOpts): Hono<Env> {
  const app = new Hono<Env>();

  const slugMw = createMiddleware<Env>(async (c, next) => {
    // biome-ignore lint/style/noNonNullAssertion: slug param guaranteed by route pattern
    c.set("slug", validateSlug(c.req.param("slug")!));
    await next();
  });

  const ownerMw = createMiddleware<Env>(async (c, next) => {
    c.set(
      "keyHash",
      await requireOwner(c.req.raw, {
        slug: c.get("slug"),
        store: c.env.store,
      }),
    );
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

  app.use("*", cors());
  app.use(
    "*",
    secureHeaders({
      crossOriginOpenerPolicy: "same-origin",
      crossOriginEmbedderPolicy: "credentialless",
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: err.message }, 400);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    const path = new URL(c.req.url).pathname;
    console.error(`Unhandled error on ${path}: ${errMsg}\n${stack}`);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/:slug{[a-z0-9][a-z0-9_-]*[a-z0-9]}", (c) => {
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), 301);
  });

  app.post("/:slug/deploy", slugMw, ownerMw, handleDeploy);
  app.get("/:slug/secret", slugMw, ownerMw, handleSecretList);
  app.put("/:slug/secret", slugMw, ownerMw, handleSecretSet);
  app.delete("/:slug/secret/:key", slugMw, ownerMw, handleSecretDelete);
  app.post("/:slug/kv", internalMw, slugMw, scopeTokenMw, handleKv);
  app.post("/:slug/vector", slugMw, ownerMw, handleVector);

  app.get("/:slug/metrics", slugMw, ownerMw, async (c) => {
    return c.text(await serializeForAgent(c.get("slug")), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    });
  });

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
  app.fetch = (req: Request, env?: Record<string, unknown>) => {
    return original(req, { ...bindings, ...env });
  };

  return app;
}
