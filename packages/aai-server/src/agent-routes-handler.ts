// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/api/*` — an agent's own `agent({ routes })`, brokered to its sandbox.
 *
 * Same reason as `/:slug/workflows/*` (`workflow-handler.ts`): the agent's page
 * is served at `/:slug/` and calls its routes with a relative `fetch("api/…")`,
 * so the request lands on the platform, which has to broker the sandbox and
 * forward. Without this route every deployed agent that declares `routes` 404s
 * while the same page works under `aai dev`.
 *
 * What it shares with the workflow proxy: the broker's failure taxonomy (a
 * booting sandbox is a retryable 503, a deleted agent a 404 — `gone`), the API
 * hop's header allow-lists, and a per-IP limit that runs BEFORE brokering.
 *
 * Where it differs, deliberately:
 *
 * - **No `GUEST_PROXY_TOKEN_HEADER`.** The guest hands a route its request
 *   headers WHOLE (`RouteRequest.headers`), so the manage bearer would reach
 *   tenant code. The surface is unauthenticated by design anyway (as open as
 *   the server, `sdk/agent-routes.ts`), so the guest has no proxy gate to prove
 *   anything to.
 * - **`bound: "response"`.** A route answers small JSON (the guest caps the
 *   request at `MAX_ROUTE_BODY_BYTES`, 64 KB) and streams nothing, so the
 *   deadline can cover the whole reply.
 *
 * Signature headers a webhook sender adds (`Stripe-Signature`, …) do NOT cross:
 * the request is allow-listed (`GUEST_API_REQUEST_HEADERS`). A route verifying
 * a third party's signature works under `aai dev` and self-hosted only, until a
 * feature asks for the pass-through the durable-run webhook uses.
 */

import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { clientIp } from "./client-ip.ts";
import type { AppContext, HonoEnv } from "./context.ts";
import {
  forwardToGuest,
  GUEST_API_REQUEST_HEADERS,
  GUEST_API_RESPONSE_HEADERS,
  pickHeaders,
} from "./guest/forward.ts";
import { GUEST_ROUTE_EXPOSURE, GUEST_ROUTES } from "./guest/routes.ts";
import { AGENT_ROUTES_IP_RATE_LIMIT, createRateLimiter, type RateLimiter } from "./rate-limit.ts";
import type { ResolveSandboxOpts } from "./sandbox/resolve.ts";
import { brokerGuestOrigin, gone, guestTarget, unavailable } from "./workflow-handler.ts";
import { WORKFLOW_PROXY_TIMEOUT_MS } from "./workflow-proxy-constants.ts";

/**
 * Build the `/:slug/api/*` proxy handler. The guest `fetch` is injectable so a
 * spec needs no sandbox.
 */
export function createAgentRoutesHandler(
  fetchFn: typeof fetch = fetch,
): (c: AppContext, broker: ResolveSandboxOpts) => Promise<Response> {
  return async (c, broker) => {
    const slug = c.var.slug;
    const guestOrigin = await brokerGuestOrigin(slug, broker, GUEST_ROUTES.api);
    // The resident fast path serves a deleted agent's sandbox until it drains,
    // so the row is what says "gone" (see `workflow-handler.ts`).
    if ((await c.env.store.getAgentVersion(slug)) === null) throw gone(slug);

    let guestResponse: Response;
    try {
      guestResponse = await forwardToGuest({
        fetchFn,
        url: guestTarget(c.req.url, slug, guestOrigin, GUEST_ROUTES.api),
        method: c.req.method,
        headers: pickHeaders(c.req.raw.headers, GUEST_API_REQUEST_HEADERS),
        body: c.req.method === "GET" || c.req.method === "HEAD" ? null : c.req.raw.body,
        timeoutMs: WORKFLOW_PROXY_TIMEOUT_MS,
        bound: "response",
      });
    } catch (cause) {
      if ((await c.env.store.getAgentVersion(slug)) === null) throw gone(slug);
      throw unavailable(cause);
    }
    const headers = pickHeaders(guestResponse.headers, GUEST_API_RESPONSE_HEADERS);
    return new Response(guestResponse.body, { status: guestResponse.status, headers });
  };
}

/**
 * Per-IP limit for the surface, run BEFORE the handler so a refused request
 * never brokers (brokering is what boots a sandbox).
 */
export function createAgentRoutesRateLimitMw(limiter?: RateLimiter) {
  const surface = limiter ?? createRateLimiter(AGENT_ROUTES_IP_RATE_LIMIT);
  return createMiddleware<HonoEnv>(async (c, next) => {
    const verdict = await surface.check(clientIp(c.req.raw));
    if (!verdict.ok) {
      return c.json({ error: "Too many requests — try again later" }, 429, {
        "Retry-After": String(verdict.retryAfterSeconds),
      });
    }
    await next();
  });
}

/**
 * Register `/:slug/api` and everything under it on the `/:slug` router, for
 * every method the exposure declares (the parity test in `guest/routes.test.ts`
 * reads the router).
 *
 * @internal
 */
export function registerAgentApiRoutes(
  agents: Hono<HonoEnv>,
  opts: {
    broker: ResolveSandboxOpts;
    guestFetch?: typeof fetch | undefined;
    rateLimiter?: RateLimiter | undefined;
  },
): void {
  const handle = createAgentRoutesHandler(opts.guestFetch);
  agents.on(
    [...GUEST_ROUTE_EXPOSURE.api.methods],
    [GUEST_ROUTES.api, `${GUEST_ROUTES.api}/:path{.+}`],
    createAgentRoutesRateLimitMw(opts.rateLimiter),
    (c) => handle(c, opts.broker),
  );
}
