// Copyright 2026 the AAI authors. MIT license.
/**
 * Base HTTP middleware shared by the platform's Hono apps — the agent
 * orchestrator and the standalone studio app (studio/studio-app.ts). One
 * implementation so the two services can't drift on CORS or the security
 * headers; the studio preview iframes agent pages, which only works while
 * both surfaces agree on the framing policy.
 */

import type { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { HonoEnv } from "./context.ts";
import { createErrorHandler } from "./error-handler.ts";

export function applyPlatformMiddleware<E extends HonoEnv>(
  // Generic over the env so a service that ADDS bindings (the studio's
  // StudioHonoEnv) can share this: Hono's env parameter is invariant, so a
  // concrete `Hono<HonoEnv>` would reject a superset.
  app: Hono<E>,
  allowedOrigins: string[] | undefined,
): void {
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
      // pages, so this does not widen the tenant boundary. The split
      // deployment preserves same-origin by routing both services through
      // one public origin (the agent service proxies /studio — see
      // studio-proxy.ts).
      xFrameOptions: "SAMEORIGIN",
    }),
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError(createErrorHandler());
}

/**
 * The drain-aware `/health` route both apps serve. 503 while draining is
 * what pulls the replica out of the platform proxy's rotation, so new
 * traffic goes to a replica that is staying up — without it the drain would
 * keep accepting the very sessions it is waiting to finish.
 */
export function addHealthRoute<E extends HonoEnv>(
  app: Hono<E>,
  isDraining: (() => boolean) | undefined,
): void {
  app.get("/health", (c) =>
    isDraining?.() ? c.json({ status: "draining" }, 503) : c.json({ status: "ok" }),
  );
}

/**
 * Inject the server-level bindings into every `app.fetch` call, keeping a
 * caller-supplied env able to override individual bindings (tests do).
 */
export function bindFetchEnv<E extends HonoEnv>(app: Hono<E>, bindings: E["Bindings"]): void {
  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });
}
