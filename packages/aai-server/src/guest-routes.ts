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
 *
 * **Two thirds of the table is IMPORTED, not transcribed.** Of the routes below,
 * ten are served by `@alexkroman1/aai-runtime` — six by `createServer` and four
 * by `handleWorkflowRequest`, which the harness mounts through the `request`
 * hook — and this package already depends on that one. They arrive as
 * `SERVER_ROUTES` and `WORKFLOW_CALLBACK_ROUTES`, so a rename there is a
 * compile error here rather than a 404 a client reads as a dead sandbox. The
 * boundary this respects is "aai-server must never import GUEST source"; the
 * runtime is not guest source, and `guest-routes.test.ts` has imported
 * `WORKFLOW_API_METHODS` across the same line all along.
 *
 * What stays hand-written is the seven routes the HARNESS itself serves — the
 * control channel, the three studio surfaces and the three `/manage` ones —
 * which really are guest source and really cannot be imported. That is also the
 * whole remaining job of `guard-invariants` rule 12: its scan can now be read as
 * covering the routes nothing else can see.
 */

import { SERVER_ROUTES, WORKFLOW_CALLBACK_ROUTES } from "@alexkroman1/aai-runtime/internal";

/** Paths the guest harness serves. Mirrors aai-guest's own dispatch. */
export const GUEST_ROUTES = {
  /** Host↔guest JSON-RPC control channel (bearer-gated; studio mode only). */
  control: "/ws",
  /** PUBLIC client voice sessions, connected directly by browsers. */
  session: SERVER_ROUTES.session.path,
  /**
   * PUBLIC carrier media streams (Twilio, Telnyx), connected directly by the
   * carrier. Same posture as `session` above: the TwiML at
   * `POST /:slug/phone` hands the carrier this URL and the carrier dials it.
   */
  phone: SERVER_ROUTES.phone.path,
  /** PUBLIC studio coding-agent chat (SSE), bearer-gated by the caller's key. */
  studioChat: "/studio/chat",
  /**
   * PUBLIC tool-name → label map for the studio's activity view, gated by the
   * same chat token as `studioChat` and served by the same handler.
   *
   * It existed as a guest route for some time before it existed HERE, which is
   * what `guard-invariants.mjs` rule 12 now prevents: the `satisfies` below
   * only catches a key with no exposure entry, never a route nobody wrote down.
   * While it was undeclared the studio client reached it by rewriting another
   * route's URL (`sessionUrl.replace(/\/chat$/, "/tools")`) — the exact URL
   * surgery this module's opening comment says the table exists to end.
   */
  studioTools: "/studio/tools",
  /**
   * Studio session install, bearer-gated by the PER-SANDBOX HOST TOKEN. The
   * HTTP twin of the `studio/session-init` RPC, for the replica that does not
   * hold this guest's single control socket (see aai-guest/
   * studio-session-init.ts and studio-session-registry.ts).
   */
  studioSessionInit: "/studio/session-init",
  /** PUBLIC readiness probe (the SDK server's own /health). */
  health: SERVER_ROUTES.health.path,
  /** PUBLIC pre-connection client config (the SDK server's own route). */
  clientConfig: SERVER_ROUTES.clientConfig.path,
  /**
   * PUBLIC durable-workflow API (the SDK server's own route) — closed only when
   * the agent's env sets `AAI_WORKFLOW_API_TOKEN`.
   *
   * A programmatic caller (`aai workflow`, a script) reaches it through the
   * platform, and a PAGE has no other way to: a `page: "static"` agent is served
   * by this platform at `GET /:slug/`, and `createWorkflowApi` builds every
   * request URL from `location.origin + location.pathname` with no broker step
   * of the kind the voice session gets from `/client-config`. So its calls land
   * on the platform, and without a route here every one of them would fall
   * through to `app.notFound` and read to the user as a failure of the feature.
   * `workflow-handler.ts` is that route; this constant names the path for both
   * sides of it.
   */
  workflows: SERVER_ROUTES.workflows.path,
  /**
   * The PLATFORM's delivery door for a queue message it owns.
   *
   * There used to be two DevKit queue callbacks above this — `workflowFlow` and
   * `workflowStep`, `guest-internal` and refused from any peer that was not
   * loopback. They went with the DevKit: the replay engine runs a step INLINE
   * during the walk rather than as its own message, so this is now the only way
   * a queue message reaches a guest.
   *
   * It is the PLATFORM's queue, which lives outside the container, so it needs a
   * credential rather than a network position — see `aai-runtime/workflow-serve.ts`.
   */
  workflowQueue: WORKFLOW_CALLBACK_ROUTES.queue.path,
  /**
   * Webhook delivery to a parked run — `createWebhook()`'s URL, minus its token.
   *
   * The only one of the three a THIRD PARTY calls: the URL is handed out of the
   * system (a payment provider, an approval mail), so it has to keep working
   * from the public internet.
   */
  workflowWebhook: WORKFLOW_CALLBACK_ROUTES.webhook.path,
  /**
   * PUBLIC read of one session's retained event stream (the SDK server's own
   * route) — bearer-gated, and OFF unless the agent's env sets
   * `AAI_SESSION_EVENTS_TOKEN`.
   *
   * Closed by default where `workflows` above is open, and the difference is
   * the caller: a workflow app's PAGE has no credential to present, so
   * fail-open is the only way it could work at all, while nothing in the
   * product reads this one — a reconnecting browser is restored server-side —
   * and its content is the conversation itself.
   */
  sessionEvents: SERVER_ROUTES.sessionEvents.path,
  /** Agent-mode management surface (bearer-gated): session count + drain. */
  manageStatus: "/manage/status",
  manageDrain: "/manage/drain",
  /**
   * This guest's own captured stdout/stderr, by cursor
   * (`?after=<seq>&limit=<n>`), bearer-gated like the rest of `/manage`.
   *
   * It is the GUEST that holds the ring, not the platform, and the reason is
   * the same one behind `sandbox-directory.ts`: a resident sandbox belongs to
   * one replica, and the others reach it by dialling the sandbox rather than
   * proxying through its owner — so a host-side buffer would be readable from
   * exactly one replica of N. See `aai-guest/harness-logs.ts`.
   */
  manageLogs: "/manage/logs",
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
/**
 * Every method a `proxied` route may declare.
 *
 * A plain union, and it used to be a runtime `PROXIED_HTTP_METHODS` array with
 * the union derived from it — because one route declared the WHOLE vocabulary
 * and `guest-routes.test.ts` had to name it. That was the webhook, on the
 * argument that the sender owns the verb; it gates POST now, so no declaration
 * names the vocabulary any more and every proxied route's methods are read from
 * the table that serves them. A constant nothing reads is a constant that goes
 * stale, so it is gone rather than kept for symmetry.
 */
export type ProxiedHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type GuestRouteExposure =
  | {
      via: "proxied";
      methods: readonly ProxiedHttpMethod[];
      /**
       * Extra path pattern the PLATFORM route carries beyond the guest path.
       *
       * For a route whose last segment is a parameter the guest path is only a
       * PREFIX — the guest parses the segment off it itself (`webhookToken` in
       * `aai-runtime/workflow-webhook.ts`) — so `/:slug<path>` alone would register
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
  // Both studio surfaces are dialled by the BROWSER, straight at the sandbox
  // tunnel, holding the chat token the session install minted — which is why
  // `studio-static.ts` has to put the sandbox origin in the page's
  // `connect-src` at all ("the browser talks straight to the project's
  // sandbox, the same way voice sessions connect directly to a deployed
  // agent"). `studioChat` said `host-only` here, which claims the opposite:
  // that the platform dials it and no client does. Same shape as the mistake
  // the `guest-internal` note above warns about — an exposure that describes a
  // gate other than the one that is there.
  studioChat: { via: "direct-dial" },
  studioTools: { via: "direct-dial" },
  studioSessionInit: { via: "host-only" },
  // `/:slug/health` exists on the platform but is the PLATFORM's answer about
  // an agent (`handleAgentHealth`), not a forward of the guest's own probe,
  // which only the host and Modal's readiness probe ever call.
  health: { via: "host-only" },
  clientConfig: { via: "proxied", methods: ["GET"] },
  // All four methods, because the guest answers all four — and each of the last
  // two was added only after the exact failure this table's header describes.
  //
  // DELETE: `api.cancel(runId)` is a DELETE, and a platform declaring only GET
  // and POST 404s every Stop button on a DEPLOYED agent while the same page
  // works under `aai dev`.
  //
  // PUT: `api.uploadStream(id, file)` is a PUT — the call that lets a run start
  // before its file has finished arriving. Same failure, third time: the streaming
  // upload worked against `aai dev` (which serves the guest's own routes) and 404d
  // in a studio preview, where the hook read the 404 as a failed upload and
  // CANCELLED the run half a second after starting it. The symptom names nothing:
  // the log says `Workflow run cancelled` and the page says the upload failed.
  workflows: { via: "proxied", methods: ["GET", "POST", "PUT", "DELETE"] },
  // DIRECT-DIAL, and the choice is worth stating because `proxied` was the
  // other candidate and is what an audit ingester would want.
  //
  // What direct-dial costs: a Modal tunnel URL dies with the sandbox, and an
  // agent guest self-exits on idle — so this reads a LIVE session's log, or one
  // whose sandbox is still up, and not a call from last week. What it avoids is
  // a platform route that would have to BOOT a sandbox to read rows back out of
  // the tenant's own Postgres, on a surface with no in-product caller.
  //
  // The cases proxying would serve are already served better: an operator reads
  // `aai_session_events` in the app schema with SQL, and an INGESTER uses the
  // hook surface (`agent({ events })`) to write each event where it wants as it
  // happens — which is also the only version that does not depend on a sandbox
  // being alive. Promoting this to `proxied` is one route registration plus the
  // methods declared here, if a caller turns up that needs it.
  sessionEvents: { via: "direct-dial" },
  // HOST-ONLY: the platform dials this over the sandbox tunnel with the
  // per-sandbox manage bearer, and the guest re-walks the run named by the queue
  // name. Not `proxied` — no client has any business driving another
  // tenant's run. The
  // guest refuses it when its composition supplies no way to vouch for a
  // caller, so `aai dev`, host mode and a self-hosted server answer 401 rather
  // than opening a door with no queue behind it.
  workflowQueue: { via: "host-only" },
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
    // POST, and only POST — matching `WORKFLOW_CALLBACK_ROUTES.webhook.methods`,
    // which is what the guest's `createServer` gates the route on (405 with
    // `Allow: POST` to anything else).
    //
    // This said "whatever verb the far side chooses: the sender owns that
    // decision", and listed all five. The guest really did answer any verb, and
    // that was the bug rather than the contract: a delivery is PERMANENT — it
    // resolves the run's waitpoint and closes the hook — so a bare `GET` from a
    // link-preview fetcher, a URL scanner or a mail client's link checker
    // following a leaked callback URL resolved an approval workflow with `{}`
    // and no human anywhere near it.
    //
    // Narrowed HERE too rather than left to the guest, and the reason is
    // specific to this route: the platform handler BROKERS
    // (`workflow-webhook-handler.ts`), so a forwarded `GET` is not a wasted
    // round trip but a Modal sandbox boot — on the one unauthenticated,
    // scannable door in the product, where the URL is handed to third parties
    // and therefore leaks by design. The "one source of truth for the verb"
    // argument for forwarding is answered by DERIVING rather than by
    // forwarding: `guest-routes.test.ts` pins this list against the runtime's
    // own table, so the two cannot drift and neither has to guess.
    //
    // What it COSTS, stated because it is a real difference and not nothing:
    // Hono has no automatic 405, so a deployed `GET` here now falls through to
    // `app.notFound` and gets a 404 with no `Allow: POST` — where a direct dial
    // to the guest gets the guest's 405 naming the verb. A sender that guessed
    // wrong therefore loses the self-correcting answer on the platform hop. It
    // is the right trade twice over: a 404 is already what this route answers
    // for an unknown slug or a closed hook, so the shape is one a webhook
    // sender's error handling has to cope with anyway, and `aai dev` — where an
    // integration is actually written — serves the guest directly and still
    // answers 405. Registering a catch-all here purely to emit 405 would put an
    // unauthenticated wildcard on the agent surface for a diagnostic.
    methods: ["POST"],
    // The token segment — the only thing identifying the run, and the only
    // authorization this endpoint performs.
    suffix: "/:token",
  },
  manageStatus: { via: "host-only" },
  manageDrain: { via: "host-only" },
  // HOST-ONLY, though a user-facing pane reads it — because the credential
  // that opens it is the platform's. `GET /:slug/logs` is the caller's door,
  // authenticated by their own API key, and the platform dials this one with
  // the per-sandbox bearer on their behalf. Same shape as `health`: a platform
  // route about an agent, not a forward of the guest's route. Declaring it
  // `proxied` would claim the tunnel accepts an unauthenticated read of every
  // line the agent has printed.
  manageLogs: { via: "host-only" },
} satisfies Record<keyof typeof GUEST_ROUTES, GuestRouteExposure>;

/**
 * Path + methods for every route the platform must proxy under `/:slug`.
 *
 * The path is the PLATFORM's, suffix included (see `GuestRouteExposure`), so it
 * is a plain string rather than a {@link GuestRoute}: `/:slug<path>` is what the
 * orchestrator has to register for a request to match.
 */
export function proxiedGuestRoutes(): {
  key: keyof typeof GUEST_ROUTES;
  path: string;
  methods: readonly string[];
}[] {
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
            // The KEY travels too: the methods a route answers have a different
            // SOURCE per route (the SDK's own route table, its client-config
            // dispatch, or "any verb"), and `guest-routes.test.ts` maps each key
            // to the one that owns it. Path is the wrong join column for that —
            // it carries the suffix.
            key: key as keyof typeof GUEST_ROUTES,
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
