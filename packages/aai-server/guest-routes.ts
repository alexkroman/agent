// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest harness's HTTP/WebSocket surface, spelled once.
 *
 * Each backend used to hardcode `/ws` and `/websocket` when building its URLs,
 * and `WarmHarness.sessionUrl` was a bare string that the studio package then
 * reverse-engineered — swapping the scheme and overwriting the pathname — to
 * reach a third surface it was never handed. Renaming or adding a guest route
 * therefore meant editing both backends plus URL surgery in another package,
 * and a mismatch surfaces only as a 404 the client reads as a dead sandbox,
 * re-brokering against it forever with no server-side error.
 *
 * Backends now report the guest's ORIGIN and everything derives routes from
 * these constants.
 */

/** Paths the guest harness serves. Mirrors aai-guest's own dispatch. */
export const GUEST_ROUTES = {
  /** Host↔guest JSON-RPC control channel (bearer-gated; studio mode only). */
  control: "/ws",
  /** PUBLIC client voice sessions, connected directly by browsers. */
  session: "/websocket",
  /**
   * PUBLIC carrier media streams (Twilio, Telnyx), connected directly by the
   * carrier. Same posture as `session` above: the TwiML at
   * `POST /:slug/phone` hands the carrier this URL and the carrier dials it.
   */
  phone: "/phone",
  /** PUBLIC studio coding-agent chat (SSE), bearer-gated by the caller's key. */
  studioChat: "/studio/chat",
  /**
   * Studio session install, bearer-gated by the PER-SANDBOX HOST TOKEN. The
   * HTTP twin of the `studio/session-init` RPC, for the replica that does not
   * hold this guest's single control socket (see aai-guest/
   * studio-session-init.ts and studio-session-registry.ts).
   */
  studioSessionInit: "/studio/session-init",
  /** PUBLIC readiness probe (the SDK server's own /health). */
  health: "/health",
  /** PUBLIC pre-connection client config (the SDK server's own route). */
  clientConfig: "/client-config",
  /** Agent-mode management surface (bearer-gated): session count + drain. */
  manageStatus: "/manage/status",
  manageDrain: "/manage/drain",
  /**
   * PUBLIC durable-workflow API (the SDK server's own route) — closed only when
   * the agent's env sets `AAI_WORKFLOW_API_TOKEN`.
   *
   * A programmatic caller reaches the guest directly, exactly as a voice client
   * does. A PAGE cannot, and this said otherwise for a while: a static agent's
   * page is served by the platform at `GET /:slug/` and builds every request
   * URL from `location`, with no broker step of the kind the voice session gets
   * from `/client-config` — so its calls land on the platform, which had no
   * route for them and answered `{"error":"Not found"}`. `workflow-handler.ts`
   * is that route; this constant names the path for both sides of it.
   */
  workflows: "/workflows",
} as const;

export type GuestRoute = (typeof GUEST_ROUTES)[keyof typeof GUEST_ROUTES];

/**
 * How a caller reaches a guest route once the agent is DEPLOYED.
 *
 * - `proxied` — the platform must serve `/:slug<path>` for each listed method
 *   and forward it to the guest. The methods are the ones the GUEST answers.
 * - `direct-dial` — the caller connects to the sandbox tunnel itself, having
 *   been handed the URL (a browser voice session; a carrier given TwiML). The
 *   platform serves no path of its own for it.
 * - `host-only` — reached by the platform through the sandbox URL, never by a
 *   client, and bearer-gated.
 */
export type GuestRouteExposure =
  | { via: "proxied"; methods: readonly ("GET" | "POST" | "PUT" | "DELETE" | "PATCH")[] }
  | { via: "direct-dial" }
  | { via: "host-only" };

/**
 * The exposure of every guest route, and the reason this table exists.
 *
 * `GUEST_ROUTES` above says a route exists; it says nothing about whether
 * anything routes to it on the platform, and that gap has produced the same
 * bug twice — both times as "works under `aai dev`, 404s once deployed", which
 * is the most expensive shape available here, because `aai dev` serves the
 * guest's own routes directly and is where every feature is developed:
 *
 * - A guest surface with NO platform route at all. Every request from a
 *   deployed page fell through to `app.notFound` and read as an error from the
 *   feature ("Could not start: Not found"), while `GUEST_ROUTES`'s own comment
 *   asserted this could not happen — true of a caller that already knows the
 *   sandbox URL, never true of one that has to be brokered.
 * - A platform route answering only SOME of the methods the guest answers. A
 *   `DELETE` (a Stop button) 404'd at the platform on every deployed agent
 *   while working perfectly under `aai dev`.
 *
 * So a new guest route has to DECLARE its exposure — the `satisfies` below
 * makes a missing entry a compile error — and `guest-routes.test.ts` asserts
 * every `proxied` method is really registered under `/:slug`. Listing the
 * methods the guest answers is what makes a half-routed surface fail: the
 * declaration is written from the guest's dispatch, and the platform then has
 * to match it.
 */
export const GUEST_ROUTE_EXPOSURE = {
  control: { via: "host-only" },
  session: { via: "direct-dial" },
  // The carrier dials this after reading the TwiML that `POST /:slug/phone`
  // answers with. That platform route is not a proxy of this one — it is the
  // webhook that hands out this URL — so this route is a direct dial.
  phone: { via: "direct-dial" },
  studioChat: { via: "host-only" },
  studioSessionInit: { via: "host-only" },
  // `/:slug/health` exists on the platform but is the PLATFORM's answer about
  // an agent (`handleAgentHealth`), not a forward of the guest's own probe,
  // which only the host and Modal's readiness probe ever call.
  health: { via: "host-only" },
  clientConfig: { via: "proxied", methods: ["GET"] },
  // DELETE as well as GET/POST: `api.cancel(runId)` is a DELETE, and the
  // platform answering only the first two 404'd every Stop button on a DEPLOYED
  // agent while the same page worked under `aai dev`. That is the second bug
  // this declaration exists to catch, and it is the one recorded in the suite's
  // own header.
  workflows: { via: "proxied", methods: ["GET", "POST", "DELETE"] },
  manageStatus: { via: "host-only" },
  manageDrain: { via: "host-only" },
} satisfies Record<keyof typeof GUEST_ROUTES, GuestRouteExposure>;

/** Path + methods for every route the platform must proxy under `/:slug`. */
export function proxiedGuestRoutes(): { path: GuestRoute; methods: readonly string[] }[] {
  // flatMap rather than filter+map so `via` narrows `methods` into existence,
  // instead of needing an `in` check whose else-branch cannot be reached.
  return Object.entries(GUEST_ROUTE_EXPOSURE).flatMap(([key, exposure]) =>
    exposure.via === "proxied"
      ? [{ path: GUEST_ROUTES[key as keyof typeof GUEST_ROUTES], methods: exposure.methods }]
      : [],
  );
}

/** A guest WebSocket URL — `ws(s)://host:port/<route>`. */
export function guestWsUrl(origin: string, route: GuestRoute): string {
  return `${origin}${route}`;
}

/**
 * A guest HTTP URL for the same origin: the harness serves HTTP and
 * WebSocket on one port, so this only swaps the scheme (`ws`→`http`,
 * `wss`→`https`).
 */
export function guestHttpUrl(origin: string, route: GuestRoute): string {
  const url = new URL(`${origin}${route}`);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  return url.toString();
}
