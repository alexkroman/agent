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
