// Copyright 2026 the AAI authors. MIT license.
/**
 * Every path this package serves, as a TABLE rather than as a dispatch chain.
 *
 * Two things read a route table, and until now only one of them existed. The
 * dispatch in `createRuntimeServer` matched `url === "/health"` inline, and
 * `aai-server`'s `GUEST_ROUTES` — the platform's statement of what a guest
 * answers — was a hand-transcribed copy of the same strings in another package.
 * Nothing joined them: `guard-invariants` rule 12 greps the guest's source for
 * route literals and requires each to be declared, which catches an ABSENT
 * route and cannot catch a WRONG one, and its own doc names the blocker —
 * "methods stay declarative until the harness's `if (url === X)` dispatch
 * becomes a table".
 *
 * This is that table. The paths are not re-declared here: each is imported from
 * the module that serves it, so this is a COLLECTION POINT and not a second
 * source of truth. The two literals that had no constant at all (`/health`,
 * `/websocket`) get one below, which is the only new spelling this module adds.
 *
 * **Two tables, because there are two mounting surfaces.** {@link SERVER_ROUTES}
 * is what `createRuntimeServer` answers on its own; {@link WORKFLOW_CALLBACK_ROUTES} is
 * what {@link handleWorkflowRequest} answers, which every front door installs
 * through the embedder's `request` hook (`aai dev` and the guest harness both
 * do) rather than getting from `createRuntimeServer`. Merging them would claim a
 * composition that does not exist — a `createRuntimeServer` with no `request` hook
 * serves the first set and none of the second.
 *
 * The precedent is `WORKFLOW_API_METHODS` in `workflow-api.ts`, which already
 * derives itself from that module's own `ROUTES` array for exactly this reason,
 * and whose doc records the platform table having "twice grown a verb it did not
 * have". This generalizes the move to the paths.
 *
 * @module server-routes
 */

import { CLIENT_CONFIG_METHODS, CLIENT_CONFIG_PATH } from "@alexkroman1/aai/protocol";
import { SESSION_EVENTS_PATH } from "./session-events-api.ts";
import { TELEPHONY_PATH } from "./telephony/telephony-server.ts";
import { WORKFLOW_API_METHODS, WORKFLOW_API_PREFIX } from "./workflow-api.ts";
import { WORKFLOW_QUEUE_PATH } from "./workflow-queue-dispatch.ts";
import { WORKFLOW_WEBHOOK_PATH } from "./workflow-serve.ts";

/**
 * Readiness. The one route with no constant of its own before this module,
 * which is why the platform's copy of it was a second literal.
 *
 * @internal
 */
export const HEALTH_PATH = "/health";

/**
 * Client voice sessions. A PREFIX match: the upgrade carries session options as
 * query parameters (`parseWsUpgradeParams`), and `requestPath` has already cut
 * the query off — so the prefix is what tolerates a trailing segment, which is
 * the shape `createRuntimeServer` has always matched with `startsWith`.
 *
 * @internal
 */
export const SESSION_PATH = "/websocket";

/**
 * The default HTML shell, served only when no `clientDir` asset claimed it.
 *
 * @internal
 */
export const ROOT_PATH = "/";

/**
 * Pre-connection client config. The SDK spells the path without a leading
 * slash (it is also a fetch target for a browser that has a base URL), so the
 * ROUTE form is derived rather than written twice.
 *
 * @internal
 */
export const CLIENT_CONFIG_ROUTE = `/${CLIENT_CONFIG_PATH}` as const;

/** How a request path is compared to a route's. @internal */
export type ServerRouteMatch = "exact" | "prefix";

/**
 * One route.
 *
 * `methods` is `"any"` rather than an empty array for a route that gates no
 * verb, because an empty list satisfies every "does the platform answer these?"
 * assertion by having nothing to check — the vacuous pass
 * `guest-routes.test.ts` already guards against in the other direction. No
 * route declares it today: the webhook was the one that did, and gating it on
 * POST is what stopped a crawler's `GET` from resolving a run's waitpoint.
 *
 * @internal
 */
export type ServerRoute =
  | {
      readonly transport: "http";
      readonly path: string;
      readonly match: ServerRouteMatch;
      readonly methods: readonly string[] | "any";
    }
  | { readonly transport: "ws"; readonly path: string; readonly match: ServerRouteMatch };

/**
 * What `createRuntimeServer` answers on its own — no embedder hook, no static assets.
 *
 * The dispatch in `server.ts` reads its paths and methods from here, so a route
 * cannot be served under a path this table does not name.
 *
 * @internal
 */
export const SERVER_ROUTES = {
  // HEAD as well as GET: a load balancer's default probe is often HEAD
  // (HAProxy's `option httpchk`, several ALB and nginx configs), and answering
  // 404 to it takes the whole deployment out of rotation while `GET /health`
  // reports ok. Declared HERE rather than only at `createAgentServer`'s door,
  // because `aai dev`, the guest harness and `createHostServer` all call
  // `createRuntimeServer` directly and would each have kept the 404. Node drops a
  // HEAD response's body itself, so the one handler serves both verbs.
  health: { transport: "http", path: HEALTH_PATH, match: "exact", methods: ["GET", "HEAD"] },
  clientConfig: {
    transport: "http",
    path: CLIENT_CONFIG_ROUTE,
    match: "exact",
    // From the protocol package, which is what a client uses to build the call.
    methods: CLIENT_CONFIG_METHODS,
  },
  root: { transport: "http", path: ROOT_PATH, match: "exact", methods: ["GET"] },
  // Derived from that module's own ROUTES array — see its doc.
  workflows: {
    transport: "http",
    path: WORKFLOW_API_PREFIX,
    match: "prefix",
    methods: WORKFLOW_API_METHODS,
  },
  sessionEvents: {
    transport: "http",
    path: SESSION_EVENTS_PATH,
    match: "prefix",
    methods: ["GET"],
  },
  session: { transport: "ws", path: SESSION_PATH, match: "prefix" },
  phone: { transport: "ws", path: TELEPHONY_PATH, match: "prefix" },
} as const satisfies Record<string, ServerRoute>;

/**
 * What {@link handleWorkflowRequest} answers, mounted by whoever supplies
 * `createRuntimeServer`'s `request` hook.
 *
 * Separate from {@link SERVER_ROUTES} because the composition really is
 * separate: `aai dev` (`_dev-server.ts`) and the guest harness
 * (`harness-manage.ts`) each install it, and a self-hosted `createRuntimeServer` with
 * no hook answers none of these.
 *
 * @internal
 */
export const WORKFLOW_CALLBACK_ROUTES = {
  // `flow` and `step` were here — the DevKit's own per-run and per-step queue
  // callbacks, POST and loopback-only. They went with it: the replay engine runs
  // a step INLINE during the walk rather than as its own message, so there is
  // nothing for a per-step callback to serve.
  //
  // The platform's delivery door: POST, and refused unless the composition
  // supplies an `allowRemote` predicate that vouches for the caller.
  queue: { transport: "http", path: WORKFLOW_QUEUE_PATH, match: "exact", methods: ["POST"] },
  // POST, and only POST. This route is the one unauthenticated public door in
  // the product and a delivery is PERMANENT — it resolves a waitpoint and
  // closes the hook — so "whatever verb the far side sends", which is what this
  // declared, meant a bare `GET` from a link-preview fetcher, a URL scanner or
  // a crawler resolved an approval workflow with an empty payload and no human
  // involved. A delivery carries a payload, so it is a verb that HAS a body;
  // anything else is answered `405` with `Allow: POST` rather than delivered.
  //
  // The SLASH-LESS form — `webhookToken` slices the token off after the prefix,
  // so what the platform registers is this plus a token segment, and
  // `WORKFLOW_WEBHOOK_PREFIX` derives from it rather than beside it.
  webhook: {
    transport: "http",
    path: WORKFLOW_WEBHOOK_PATH,
    match: "prefix",
    methods: ["POST"],
  },
} as const satisfies Record<string, ServerRoute>;

/** Does `url` hit `route`? The one place the two match modes are interpreted. @internal */
export function routeMatches(route: ServerRoute, url: string, method?: string): boolean {
  if (
    route.transport === "http" &&
    method !== undefined &&
    route.methods !== "any" &&
    !route.methods.includes(method)
  )
    return false;
  return route.match === "exact" ? url === route.path : url.startsWith(route.path);
}
