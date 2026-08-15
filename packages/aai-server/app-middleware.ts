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
import type { PlatformEvents } from "./platform-events.ts";
import { rememberPublicOrigin } from "./public-origin.ts";

/**
 * Cross-origin callers this deployment allows, from `AAI_ALLOWED_ORIGINS`.
 *
 * A comma-separated list of origins, or `*` for any. UNSET means none, and that
 * is the right default for this platform: both surfaces are same-origin by
 * construction (one process, one hostname — see "Two packages, ONE deployment"
 * in this package's guide), the browser client for a deployed agent is served
 * BY the agent's own origin, and voice sessions dial the guest tunnel rather
 * than this service.
 *
 * It is read here rather than threaded from each entry point because both
 * surfaces call this function, and this is the module that exists so the two
 * cannot drift on CORS policy — a per-service knob would be exactly that drift.
 * An explicit `allowedOrigins` argument still wins, including `[]`, so a caller
 * that has decided is never overridden by the environment.
 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.AAI_ALLOWED_ORIGINS?.trim();
  if (!raw) return undefined;
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : undefined;
}

export function applyPlatformMiddleware<E extends HonoEnv>(
  // Generic over the env so a service that ADDS bindings (the studio's
  // StudioHonoEnv) can share this: Hono's env parameter is invariant, so a
  // concrete `Hono<HonoEnv>` would reject a superset.
  app: Hono<E>,
  /**
   * Cross-origin callers to allow. `undefined` falls back to
   * {@link resolveAllowedOrigins}; `[]` (or an unset variable) rejects every
   * cross-origin request, which is this deployment's default.
   *
   * The option's doc used to claim it defaulted to `["*"]` — any origin — which
   * was the OPPOSITE of the behaviour, and nothing anywhere set it, so a reader
   * checking "is CORS open?" got the wrong answer from the only documentation
   * there was. Fail-closed, so never a hole; misleading, which is worse than it
   * sounds for a security-shaped setting.
   */
  allowedOrigins: string[] | undefined,
): void {
  const origins = allowedOrigins ?? resolveAllowedOrigins();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return "*"; // same-origin
        if (!origins) return ""; // reject when no origins configured
        if (origins.includes("*")) return "*";
        return origins.includes(origin) ? origin : "";
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: false,
      maxAge: 86_400,
    }),
  );
  // Record the origin this replica is reached on, for the code paths that need
  // it and hold no request: a guest spawn bakes the agent's public base URL into
  // its boot env, and three of the four spawn paths (blue-green handover, the
  // durable-run wake sweep, the peer route) are not serving one. Here rather
  // than in a route because it must not be a thing a route can forget, and
  // because both surfaces feed the same answer.
  //
  // **This runs before any auth, so in production it records NOTHING** — the
  // origin comes from caller-written headers, and what it wrote crossed into
  // other tenants' guests. `rememberPublicOrigin` owns that rule and the whole
  // account of the attack; read it there before moving this line.
  app.use("*", async (c, next) => {
    rememberPublicOrigin(c.req.raw);
    await next();
  });
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
      // pages, so this does not widen the tenant boundary. Same-origin holds
      // structurally: both surfaces are served by one process on one hostname
      // (see studio-paths.ts for the boundary between them).
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
 *
 * It also reports the change streams' delivery health, and **a stalled
 * channel deliberately stays a 200.** The temptation is to fail the check —
 * it is a real degradation, and failing is how you get someone's attention.
 * But the causes are almost all PROJECT-WIDE (a wrong-authority key, a
 * missing grant, Realtime itself down), so every replica would stall at once
 * and every replica would drop out of rotation together: a feature outage
 * converted into a total one, by the health check. The replica can still
 * broker sessions, serve pages, and deploy. So the signal goes in the BODY,
 * where a dashboard or an alert can read it and a load balancer cannot act
 * on it.
 */
export function addHealthRoute<E extends HonoEnv>(
  app: Hono<E>,
  isDraining: (() => boolean) | undefined,
  events?: PlatformEvents,
): void {
  app.get("/health", (c) => {
    if (isDraining?.()) return c.json({ status: "draining" }, 503);
    const stalled = events?.health().stalled ?? [];
    // Absent when healthy rather than an empty array, so the ordinary body
    // stays exactly what it has always been and the field's presence is
    // itself the signal.
    return c.json(
      stalled.length > 0 ? { status: "ok", realtimeStalled: stalled } : { status: "ok" },
    );
  });
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
