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
  /**
   * Workflow-run replay, called back by the Workflow DevKit's queue.
   *
   * The caller is the guest's OWN worker (graphile-worker, polling the app
   * database from inside this sandbox), not the platform and not a browser.
   */
  workflowFlow: "/.well-known/workflow/v1/flow",
  /** One workflow step, called back by the same queue as `workflowFlow`. */
  workflowStep: "/.well-known/workflow/v1/step",
  /**
   * Webhook delivery to a parked run — `createWebhook()`'s URL, minus its token.
   *
   * The only one of the three a THIRD PARTY calls: the URL is handed out of the
   * system (a payment provider, an approval mail), so it has to keep working
   * from the public internet.
   */
  workflowWebhook: "/.well-known/workflow/v1/webhook",
  /** Agent-mode management surface (bearer-gated): session count + drain. */
  manageStatus: "/manage/status",
  manageDrain: "/manage/drain",
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
 * - `guest-internal` — dialled only from INSIDE the container, on loopback, by
 *   the guest's own machinery. No caller outside the sandbox exists, so there
 *   is nothing to route and nothing for the platform to authenticate. Distinct
 *   from `host-only`, which says the PLATFORM dials it and implies a token
 *   guarding it: writing one of these down as `host-only` would describe a
 *   gate that is not there.
 */
export type GuestRouteExposure =
  | {
      via: "proxied";
      methods: readonly ("GET" | "POST" | "PUT" | "DELETE" | "PATCH")[];
      /**
       * Extra path pattern the PLATFORM route carries beyond the guest path.
       *
       * For a route whose last segment is a parameter the guest path is only a
       * PREFIX — the guest parses the segment off it itself (`webhookToken` in
       * `aai/host/workflow-serve.ts`) — so `/:slug<path>` alone would register
       * a route no real request matches. Declaring the suffix keeps the parity
       * test checking the path the platform must really answer.
       */
      suffix?: string;
    }
  | { via: "direct-dial" }
  | { via: "host-only" }
  | { via: "guest-internal" };

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
  // Nothing outside the sandbox calls these two: the DevKit's queue lives in
  // the guest (graphile-worker polling the app database from inside this
  // container) and dials its own server on loopback, so there is no caller to
  // route for. Not `proxied` — a platform route would be an unauthenticated
  // way for anyone to replay another tenant's run or execute one of its steps,
  // and these two are unauthenticated precisely BECAUSE loopback is the whole
  // gate. Not `host-only` either: the platform never dials them, and saying it
  // does would claim a bearer check that does not exist. Reconsider only if a
  // run's queue ever moves out of the guest — then they need a platform route
  // AND an authenticity check of their own, not one without the other.
  workflowFlow: { via: "guest-internal" },
  workflowStep: { via: "guest-internal" },
  // The one workflow route with a caller outside the container, and the reason
  // it must be brokered rather than direct-dialled: a `createWebhook()` URL is
  // handed to a THIRD PARTY (a payment provider, an approval mail) and has to
  // keep working after the sandbox that minted it is gone. A Modal tunnel URL
  // does not — it changes on every respawn — and a durable run is precisely the
  // thing that outlives the call that started it, so the guest is usually not
  // even running when the delivery arrives (agent mode self-exits on idle).
  // The platform route boots one; see workflow-webhook-handler.ts.
  workflowWebhook: {
    via: "proxied",
    // Whatever verb the far side chooses: the sender owns that decision, and
    // the guest answers any method here (`pickWorkflowHandler` in
    // `aai/host/workflow-serve.ts` gates only flow and step on POST).
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    // The token segment — the only thing identifying the run, and the only
    // authorization the DevKit performs on this endpoint.
    suffix: "/:token",
  },
  manageStatus: { via: "host-only" },
  manageDrain: { via: "host-only" },
} satisfies Record<keyof typeof GUEST_ROUTES, GuestRouteExposure>;

/**
 * Path + methods for every route the platform must proxy under `/:slug`.
 *
 * The path is the PLATFORM's, suffix included (see `GuestRouteExposure`), so it
 * is a plain string rather than a {@link GuestRoute}: `/:slug<path>` is what the
 * orchestrator has to register for a request to match.
 */
export function proxiedGuestRoutes(): { path: string; methods: readonly string[] }[] {
  // flatMap rather than filter+map so `via` narrows `methods` into existence,
  // instead of needing an `in` check whose else-branch cannot be reached.
  // Widened to the declared type before iterating: the literal object narrows
  // each entry to its own exact shape, so `suffix` would not exist on the
  // proxied entries that omit it.
  const declared = GUEST_ROUTE_EXPOSURE as Record<keyof typeof GUEST_ROUTES, GuestRouteExposure>;
  return Object.entries(declared).flatMap(([key, exposure]) =>
    exposure.via === "proxied"
      ? [
          {
            path: `${GUEST_ROUTES[key as keyof typeof GUEST_ROUTES]}${exposure.suffix ?? ""}`,
            methods: exposure.methods,
          },
        ]
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
