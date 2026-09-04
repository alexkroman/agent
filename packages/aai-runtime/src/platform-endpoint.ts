// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's end of the PLATFORM wire: one credential pair, one URL builder, and
 * the five paths declared once.
 *
 * Five modules reach the platform over HTTP — `session-state-platform.ts`,
 * `uploads-platform.ts`, `workflow-journal-platform.ts`,
 * `workflow-keys-platform.ts` and
 * `workflow-platform-queue.ts` — and each had grown its own `{base, token, fetch?}`
 * options type, its own `` `${base.replace(/\/+$/, "")}/…` ``, and its own copy of
 * the path the platform serves it on. That last one is the expensive copy: the
 * platform declares the same strings independently (`session-state-handler.ts`
 * and its siblings), so renaming or versioning one was a two-package edit whose
 * failure mode is a 404 the runtime reports as `answered HTTP 404` — a rejected
 * `hydrate`, i.e. a failed session start, with nothing naming the path.
 *
 * ## Why the paths live HERE and the server imports them
 *
 * The dependency runs one way: `aai-server` already imports this package's
 * `/internal` (the typed-json codec, the route tables), and `aai-runtime` may not
 * import the server. So the shared declaration has to sit on this side, and the
 * handlers take their `*_ROUTE` from {@link PLATFORM_ROUTES} rather than spelling a
 * literal. That is the same move `server-routes.ts` makes for the OPPOSITE
 * direction, for the same reason its doc gives.
 *
 * This is a source of truth, not a collection point — unlike `server-routes.ts`,
 * whose entries are imported from the modules that serve them. Here the callers are
 * in this package and the servers are in another, so the strings are declared once,
 * here, and both ends read them.
 *
 * ## The REQUEST is `platform-rpc.ts`, and it is a separate file
 *
 * This module is the declaration both packages read; the POST, the deadline and the
 * status check are the guest's alone. Keeping them apart is what stops `aai-server`
 * importing a fetch client to learn a path.
 *
 * @module platform-endpoint
 */

/**
 * Every path the platform serves a guest on.
 *
 * @internal
 */
export const PLATFORM_ROUTES = {
  /** Session slots and the session event log (`platform-session-state.ts`). */
  sessionState: "/session-state",
  /** Upload records — the metadata half; the bytes are brokered separately. */
  uploadRecords: "/upload-records",
  /** The replay engine's journal — the third backend, and the only durable one a deployed guest can reach. */
  workflowJournal: "/workflow-journal",
  /** The guest asking the platform to queue a message for one of its own runs. */
  workflowEnqueue: "/workflow-enqueue",
  /**
   * The correlation-key index — `(workflow, key) -> runId`.
   *
   * Its own route beside the journal rather than a method ON it, because it is a
   * different STORE with a different interface: `WorkflowKeyStore` has two methods
   * and three backends of its own, and the journal route's `METHODS` list is the
   * `JournalStore` seam. Folding them would put one route's body cap, one list and
   * one 501 across two stores that are selected independently.
   */
  workflowKeys: "/workflow-keys",
} as const;

/** One of {@link PLATFORM_ROUTES}. */
export type PlatformRoute = (typeof PLATFORM_ROUTES)[keyof typeof PLATFORM_ROUTES];

/**
 * The upgrade path a guest's MULTIPLEXED socket is opened on.
 *
 * Not a member of {@link PLATFORM_ROUTES}, and the split is the whole design: the
 * five above are what a CALL names, and this is the pipe every one of them can be
 * carried down. A frame on this socket names one of those five and is dispatched
 * to the very same handler, so nothing here is a second copy of a route — see
 * `platform-socket.ts` (the guest's end) and
 * `aai-server/platform-socket-handler.ts` (the platform's).
 *
 * It sits beside them rather than in `aai-server` for the reason the table does:
 * both ends read it, and `aai-server` may import this package while the reverse is
 * forbidden. A literal on each side is a rename away from a socket that never
 * opens — which, because the transport falls back, is a permanent HTTP deployment
 * that no test and no alert can see.
 *
 * @internal
 */
export const PLATFORM_SOCKET_PATH = "/platform-socket";

/**
 * The largest frame either end will read, in bytes.
 *
 * One number for both directions and both ends, because a cap the two disagree
 * about is a socket that dies mid-run rather than a request that is refused: the
 * reader simply closes, and every in-flight call on it fails at once.
 *
 * 16 MiB is twice the largest per-route body cap (`MAX_SESSION_STATE_BODY_BYTES`
 * and the journal's, both 8 MiB), which is what it has to clear — the ROUTE still
 * enforces its own cap on the request, and a REPLY has none of its own, so the
 * generous side is where this belongs. It is far below `ws`'s own 100 MiB default,
 * which is the number this replaces on both ends and which bounds nothing worth
 * bounding on a socket the peer is a tenant's sandbox.
 *
 * @internal
 */
export const MAX_PLATFORM_SOCKET_FRAME_BYTES = 16_777_216;

/**
 * What a guest needs to reach the platform, whichever route it is reaching.
 *
 * ONE type, aliased by each client's own name rather than restated: the four were
 * structurally identical, which is why `resolvePlatformQueue()`'s single result is
 * already handed to three of them (`runtime.ts`, `workflow-install.ts`) under three
 * different names.
 *
 * @internal
 */
export type PlatformEndpoint = {
  /**
   * Where the platform is dialable, slug included — `AAI_PLATFORM_BASE_URL`.
   *
   * The same value `_upload-blobs-brokered.ts` takes, and for the same reason: the
   * guest does not COMPOSE this URL, so it cannot name another app's slug even in
   * principle. The platform derives the tenant from the slug in the path and
   * verifies this sandbox's bearer against it.
   *
   * NOT `AAI_PUBLIC_BASE_URL`, which used to fill this slot and is a different
   * claim — that one is what a third party is handed, so it must resolve from the
   * INTERNET where this must resolve from inside the sandbox. Under a microVM
   * backend the two are different strings and the public one is the guest itself;
   * `workflow-platform-world.ts`'s `dialBase` is the reader and carries the rest.
   */
  base: string;
  /**
   * This sandbox's bearer — `AAI_GUEST_TOKEN`.
   *
   * Already in the guest's environment, because it is what the guest verifies
   * INBOUND platform requests with. Presented outbound it proves the reverse, and
   * it is bound to one sandbox name, so it authorizes exactly one slug. See
   * `aai-server/guest-bearer.ts`.
   */
  token: string;
  /**
   * Test seam — production takes the pooled HTTP/1.1 `rpcFetch`, NEVER
   * `globalThis.fetch`: see `_egress-fetch.ts`.
   */
  fetch?: typeof globalThis.fetch | undefined;
};

/**
 * `<base><route>`, plus an optional trailing SEGMENT, tolerating a trailing slash
 * on the base.
 *
 * The strip is why this is a function and not a template at each call site: six
 * copies of `` base.replace(/\/+$/, "") `` were in the tree, one of them running
 * per storage call and one running TWICE per enqueue (the second only to build a
 * timeout message that the success path discards).
 *
 * ## The segment is what makes a multi-method route READABLE in a request log
 *
 * Three of these routes are one path serving a dozen methods behind a `method`
 * field in the body, and a request log — Modal's, a proxy's, anyone's — sees the
 * path. So `POST /:slug/workflow-journal` was fourteen different operations
 * printing one line, and reconstructing which was which meant counting requests.
 * A method in the PATH decomposes that log for free, at zero added volume, which
 * is why the segment exists rather than a second log line per call.
 *
 * It is `encodeURIComponent`'d because it is a path segment and a route is not:
 * every caller passes a value off a closed list, and encoding is what keeps that
 * true of the URL even if one day a caller does not.
 *
 * @internal
 */
export function platformUrl(base: string, route: PlatformRoute, segment?: string): string {
  const suffix = segment === undefined ? "" : `/${encodeURIComponent(segment)}`;
  return `${base.replace(/\/+$/, "")}${route}${suffix}`;
}
