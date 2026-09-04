// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP + WebSocket routing for the managed platform server.
 *
 * Route structure:
 * - `GET  /`                      — browser studio (coding agent UI)
 * - `GET  /health`                — platform health check
 * - `GET  /favicon.ico`           — studio favicon
 * - `/studio/*`                   — studio API (see studio/studio-routes.ts)
 * - `POST /deploy`                — top-level deploy (server-generated slug)
 * - `GET  /:slug`                 — redirect to /:slug/
 * - `GET  /:slug/`               — agent UI page
 * - `GET  /:slug/health`         — per-agent health check
 * - `GET  /:slug/client-config`  — session broker: name/greeting + the live
 *   sandbox session URL (ensures the sandbox is running)
 * - `GET/POST /:slug/phone`     — carrier call-answering webhook: brokers the
 *   sandbox and answers with TwiML/TeXML pointing at its media-stream endpoint
 * - `PUT/GET/HEAD /:slug/uploads/:id/:offset` — one window of a workflow upload's
 *   bytes, in the platform's own bucket (upload-handler.ts). The one byte route that
 *   is NOT brokered: a guest holds no bucket credential
 * - `GET/POST/DELETE /:slug/workflows/*` — the durable-workflow API, brokered
 *   to the guest. A workflow app's page has no other way to reach it — it is
 *   served from `/:slug/` and builds every URL from `location`
 * - `/:slug/.well-known/workflow/v1/webhook/:token` — durable-run webhook
 *   delivery: brokers the sandbox (booting one for a run whose guest has long
 *   since exited) and forwards the request to the guest's own endpoint
 * - `GET  /:slug/favicon.ico`    — agent page favicon (custom or default)
 * - `GET  /:slug/assets/:path`   — client static assets
 * - `DELETE /:slug/`             — owner: delete agent
 * - `GET/PUT/DELETE /:slug/secret` — owner: manage secrets
 * - `WS   /:slug/websocket`     — the long-living programmatic endpoint:
 *   upgrades are redirected (302) to the agent's live sandbox session URL
 *
 * Auth: `authMw` validates API key; `existingOwnerMw` verifies slug ownership.
 * Slugs: `[a-z0-9][a-z0-9_-]*[a-z0-9]` — enforced by regex for multi-tenant isolation.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { createSemaphore } from "./_semaphore.ts";
import { createAgentLogsHandler } from "./agent-logs.ts";
import { startAgentSweeps } from "./agent-sweeps.ts";
import { registerAgentWorkflowRoutes } from "./agent-workflow-routes.ts";
import type { ApiKeyVerifier } from "./api-key-verify.ts";
import { addHealthRoute, applyPlatformMiddleware, bindFetchEnv } from "./app-middleware.ts";
import { createAgentClientConfigHandler } from "./client-config-handler.ts";
import { clientIp } from "./client-ip.ts";
import { DEPLOY_BODY_CONCURRENCY, DEPLOY_BODY_WAIT_MS, resolveHarnessPath } from "./constants.ts";
import type { HonoEnv } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { handleDeployNew } from "./deploy.ts";
import { gzipRequestMw, MAX_INFLATED_BODY_BYTES } from "./gzip-request.ts";
import { authMw, existingOwnerMw, slugMw } from "./middleware.ts";
import { createWsUpgrades } from "./orchestrator-ws.ts";
import { createPhoneHandler, PHONE_ROUTE } from "./phone-handler.ts";
import type { PlatformEvents } from "./platform-events.ts";
import {
  type AdminDb,
  createMutationLock,
  localSlugLock,
  type SlugMutationLock,
} from "./platform-lock.ts";
import { createRateLimiter, DEPLOY_IP_RATE_LIMIT, type RateLimiter } from "./rate-limit.ts";
import type { SandboxDirectory } from "./sandbox-directory.ts";
import { watchAgentInvalidation } from "./sandbox-invalidate.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import type { SlotCache } from "./sandbox-slots.ts";
import { currentHarnessImageTag } from "./sandbox-vm.ts";
import {
  DeployBodySchema,
  SecretKeySchema,
  SecretUpdatesSchema,
  SLUG_PATTERN_SOURCE,
} from "./schemas.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import type { StudioAuth } from "./supabase-auth.ts";
import {
  handleAgentFavicon,
  handleAgentHealth,
  handleAgentPage,
  handleClientAsset,
} from "./transport-websocket.ts";
import { createMemoryUploadBytes, type UploadBytes } from "./upload-bytes.ts";

export type OrchestratorOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Named secret storage (Supabase Vault in production, memory in tests). */
  secrets?: SecretStore;
  /** Browser-session auth; absent means raw-API-key bearers only. */
  auth?: StudioAuth;
  /**
   * Verifies raw API-key bearers against AssemblyAI (api-key-verify.ts).
   * Absent accepts any bearer string as a key — dev and tests only; the
   * production builder supplies one unless `AAI_VERIFY_API_KEYS=0`.
   */
  keyVerifier?: ApiKeyVerifier;
  /**
   * Per-client-IP limiter for `POST /deploy`. Postgres-backed in production
   * so the limit holds fleet-wide (see rate-limit.ts); the in-memory default
   * is per-replica, which is correct for a single process and weak for ten.
   */
  deployRateLimiter?: RateLimiter;
  /** Per-IP limiter for the whole `/:slug/workflows/*` surface. */
  workflowRateLimiter?: RateLimiter;
  /** Per-IP limiter for `POST /:slug/workflows/runs` — starting runs. */
  workflowStartRateLimiter?: RateLimiter;
  /**
   * How many deploy bodies may be buffered and parsed at once, and how long a
   * caller waits for a slot. Defaults to the `DEPLOY_BODY_*` constants (both
   * env-overridable); an explicit value wins, which is what lets a
   * self-hosted deployment on a bigger container raise it — and lets the
   * saturation test reach the 503 without a module-level env stub.
   */
  deployBodyConcurrency?: number;
  deployBodyWaitMs?: number;
  /**
   * Per-slug mutation lock (deploy/delete/secret/storage). Postgres lease in
   * production so replicas exclude each other; defaults to in-process.
   */
  slugLock?: SlugMutationLock;
  /**
   * The agents row's change stream — THE invalidation mechanism: deploys and
   * deletes write the row, and this stream is what retires/terminates every
   * replica's resident sandboxes (see watchAgentInvalidation). Optional only
   * for tests that never mutate agents; a composition that deploys without
   * it keeps superseded sandboxes alive until idle eviction.
   */
  events?: PlatformEvents;
  /**
   * Fleet-wide sandbox directory (sandbox-directory.ts). The slot cache is
   * per-replica and the web service autoscales, so without this each replica
   * spawns its own guest for the same deploy. Absent (the subprocess backend,
   * tests) leaves every replica independent — correct for a single process.
   */
  directory?: SandboxDirectory;
  /**
   * The platform admin connection, for the durable-workflow queue sweep
   * (`workflow-queue-sweep.ts`) — the one thing in this process that boots a
   * sandbox on a SCHEDULE rather than for a caller — and for the guest-called
   * platform routes beside it. Absent (no platform database: local dev, tests)
   * leaves the sweep unstarted and those routes answering 501, which is correct
   * there: `aai dev` runs the DevKit's local world, whose queue lives in that
   * process's own memory.
   */
  adminDb?: AdminDb;
  /**
   * Allowed CORS origins.
   *
   * Omitted falls back to `AAI_ALLOWED_ORIGINS` (comma-separated, or `*`), and
   * with that unset every cross-origin request is REJECTED — which is what this
   * has always done, despite the doc here having claimed the opposite ("any
   * origin") for as long as it existed. Same-origin callers are unaffected, and
   * this platform is same-origin by construction; see `resolveAllowedOrigins`.
   */
  allowedOrigins?: string[];
  /**
   * Test seam for platform→guest HTTP: the client-config broker's proxy fetch
   * of the guest's own `/client-config` (name/greeting come from the GUEST,
   * never the stored config — see client-config-handler.ts) and the
   * workflow-webhook forward. One option rather than one per route — both are
   * the same hop to the same sandbox, and a second name here is how a new
   * forwarding route ends up untestable by omission.
   */
  guestFetch?: typeof globalThis.fetch;
  /**
   * Where a workflow upload's WINDOWS live — `PUT/GET/HEAD /:slug/uploads/:id/:offset`.
   *
   * Defaults to memory, which is right for tests and for a dev server: the route then
   * serves windows itself rather than redirecting, because a Map has no origin to sign
   * for. Production passes `createSupabaseUploadBytes`, and a deployment that forgot to
   * loses nothing silently — a deployed agent's brokered client would be writing into a
   * bucket this replica does not have, so the first upload fails at the route rather
   * than being stored somewhere it will not be found.
   */
  uploadBytes?: UploadBytes;
  /**
   * True once shutdown has begun. Fails `/health` so the platform's proxy
   * stops routing here, and REFUSES a new `/:slug/platform-socket` upgrade.
   *
   * Upgrades on `/:slug/websocket` are still pure handshake redirects to the
   * sandbox, so there is nothing long-lived to refuse there. The platform
   * socket is the one upgrade this server really terminates, which is why the
   * sentence that used to end "nothing long-lived starts here" no longer holds
   * — see `platform-socket-handler.ts`.
   */
  isDraining?: () => boolean;
};

export type Orchestrator = {
  app: Hono<HonoEnv>;
  injectWebSocket: (server: import("node:http").Server) => void;
};

export function createOrchestrator(opts: OrchestratorOpts): Orchestrator {
  const app = new Hono<HonoEnv>();
  applyPlatformMiddleware(app, opts.allowedOrigins);

  // Sandbox invalidation is event-driven, wired here so every composition
  // (agent service, combined, tests) gets it with the orchestrator rather
  // than each entry re-wiring it. Lives for the process, like the slots.
  if (opts.events) watchAgentInvalidation(opts.events, opts);

  addHealthRoute(app, opts.isDraining, opts.events);

  // This app never serves the studio surface itself — the studio is its own
  // package, and the combined composition (aai-studio-server's entry, what
  // production runs) dispatches studio paths to it by `isStudioPath` before
  // this app ever sees them. So `/` here is only reached when the orchestrator
  // runs alone, which in practice means tests. `studio` and `studio-assets`
  // are still reserved slugs (RESERVED_SLUGS) so no agent route can shadow the
  // namespace — see studio-paths.ts.
  app.get("/", (c) => c.json({ service: "aai-agent", studio: "not served by this app" }));

  // Cap the on-the-wire deploy body (compressed or not) before anything
  // buffers it. gzipRequestMw separately caps the DECOMPRESSED size, so a
  // zip bomb is bounded on both axes.
  const deployBodyLimit = bodyLimit({
    maxSize: MAX_INFLATED_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });

  // Per-IP deploy limit. Runs ahead of the body gate so a refused caller
  // never occupies one of its slots — otherwise the cheap control queues
  // behind the expensive one it is meant to protect.
  const deployLimiter = opts.deployRateLimiter ?? createRateLimiter(DEPLOY_IP_RATE_LIMIT);
  const deployRateMw = createMiddleware<HonoEnv>(async (c, next) => {
    const verdict = await deployLimiter.check(clientIp(c.req.raw));
    if (!verdict.ok) {
      return c.json({ error: "Too many deploys — try again later" }, 429, {
        "Retry-After": String(verdict.retryAfterSeconds),
      });
    }
    await next();
  });

  // ...and cap how many deploy bodies are in flight together, which is the axis
  // the two size limits above cannot bound: peak memory was arrival rate times
  // ~164 MB, and arrival rate is the caller's to choose. Runs ahead of
  // bodyLimit and the gunzip, so a refused request has allocated nothing — and
  // behind `authMw`, for the reason spelled out at the route below.
  // Per-replica by construction: this bounds THIS container's heap, which is a
  // process-local resource, so it wants no cross-replica coordination.
  const deployBodySlots = createSemaphore(opts.deployBodyConcurrency ?? DEPLOY_BODY_CONCURRENCY);
  const deployBodyWaitMs = opts.deployBodyWaitMs ?? DEPLOY_BODY_WAIT_MS;
  const deployBodyGate = createMiddleware<HonoEnv>(async (c, next) => {
    const slot = await deployBodySlots.acquire(deployBodyWaitMs);
    if (!slot) {
      return c.json({ error: "Server busy — retry shortly" }, 503, {
        "Retry-After": String(Math.max(1, Math.ceil(deployBodyWaitMs / 1000))),
      });
    }
    try {
      await next();
    } finally {
      // Released once the handler has RETURNED, which is after the body was
      // parsed and after `putAgent` uploaded it — the whole window in which
      // this request is holding the bytes.
      slot();
    }
  });

  // Deploys record the harness image they ran against (per-deploy image
  // pinning — see currentHarnessImageTag in sandbox-vm.ts).
  const harnessImageTag = (): Promise<string | null> =>
    currentHarnessImageTag(resolveHarnessPath());

  // ORDER IS THE POINT. `authMw` runs AHEAD of the body gate, not behind it.
  // The gate's slots exist to bound BUFFERED BYTES (see `_semaphore.ts` and
  // `DEPLOY_BODY_CONCURRENCY`), and a slot held across `authMw` bounds latency
  // instead: `assertVerifiedApiKey`'s 5s outbound fetch to AssemblyAI plus a
  // Vault round trip sat inside the critical section, so two junk-bearer
  // requests could hold both slots while AssemblyAI was slow and 503 every
  // legitimate deploy behind them. `authMw` reads headers only — it buffers
  // nothing — so moving it in front costs the gate nothing and takes the
  // unauthenticated caller out of it entirely. The rate limiter stays first,
  // for the same reason it was already there.
  app.post(
    "/deploy",
    deployRateMw,
    authMw,
    deployBodyGate,
    deployBodyLimit,
    gzipRequestMw,
    zValidator("json", DeployBodySchema),
    (c) => handleDeployNew(c, harnessImageTag),
  );

  // Bare-slug redirect — registered before sub-router so it takes priority.
  // Pattern composed from the shared slug grammar (SLUG_PATTERN_SOURCE).
  app.get(`/:slug{${SLUG_PATTERN_SOURCE}}`, (c) => {
    const url = new URL(c.req.url);
    // Relative Location (RFC 7231 §7.1.2): behind Modal's TLS termination
    // the request URL is always cleartext http, so echoing an absolute URL
    // back bounced an https browser to `http://…` and then straight back
    // through the edge's upgrade redirect. A path can't downgrade anything.
    return c.redirect(`${url.pathname}/${url.search}`, 301);
  });

  // Tests build orchestrators without a secret store; default to memory so
  // the storage-status route (and anything else reading secrets) works.
  const secrets = opts.secrets ?? createMemorySecretStore();

  // The broker's dependency set, assembled ONCE and shared by both consumers
  // (the client-config route and the /:slug/websocket redirect path): every
  // field is optional, so a per-site conditional spread that drops one
  // compiles clean — one object makes a new broker dependency one edit.
  const brokerOpts: ResolveSandboxOpts = {
    slots: opts.slots,
    store: opts.store,
    secrets,
    ...omitUndefined({ directory: opts.directory }),
    // Same predicate `/health` reports on, so "the proxy has been told to
    // stop routing here" and "stop booting sandboxes" can never disagree.
    ...omitUndefined({ isDraining: opts.isDraining }),
  };

  // Every process-lifetime background pass this surface owns (agent-sweeps.ts).
  // Wired here for the same reason `watchAgentInvalidation` is: an entry point
  // that has to remember to start one is an entry point that will not.
  startAgentSweeps({
    store: opts.store,
    broker: brokerOpts,
    ...omitUndefined({ adminDb: opts.adminDb }),
    ...omitUndefined({ isDraining: opts.isDraining }),
  });

  const agents = new Hono<HonoEnv>();
  agents.use("*", slugMw);

  // Deploys go through the top-level `POST /deploy` (slug in the body). Every
  // owner-scoped route here operates on an existing agent's data/secrets and
  // uses existingOwnerMw, which rejects unclaimed slugs.
  agents.delete("/", existingOwnerMw, handleDelete);
  agents.get("/secret", existingOwnerMw, handleSecretList);
  agents.put("/secret", existingOwnerMw, zValidator("json", SecretUpdatesSchema), handleSecretSet);
  agents.delete(
    "/secret/:key",
    existingOwnerMw,
    zValidator("param", z.object({ key: SecretKeySchema })),
    handleSecretDelete,
  );
  // The agent's own buffered stdout/stderr. Owner-authenticated like the
  // routes above — an agent's output is its author's, and nothing else — and
  // unlike every other `/:slug/*` route it never BOOTS a sandbox (agent-logs.ts).
  agents.get(
    "/logs",
    existingOwnerMw,
    createAgentLogsHandler({
      slots: opts.slots,
      ...omitUndefined({ directory: opts.directory }),
    }),
  );

  agents.get("/health", handleAgentHealth);
  // Session broker: the live sandbox session URL (boots the sandbox on first
  // request) plus name/greeting PROXIED from the guest's own /client-config.
  // Same auth posture as the page and the session endpoint: none.
  const handleAgentClientConfig = createAgentClientConfigHandler(opts.guestFetch);
  agents.get("/client-config", (c) => handleAgentClientConfig(c, brokerOpts));
  // Call-answering webhook: brokers the sandbox and answers with the TwiML
  // that points the carrier at the guest's own /phone endpoint. Same auth
  // posture as the routes above — none by default; an agent that stores its
  // carrier's signing secret gets every request verified (phone-signature.ts).
  // GET as well as POST because a carrier's webhook method is the operator's
  // to configure, and a GET-configured number should work rather than 405.
  const handlePhone = createPhoneHandler({ store: opts.store });
  agents.on(["GET", "POST"], PHONE_ROUTE, (c) => handlePhone(c, brokerOpts));
  // Every `/:slug/*` route the durable-workflow feature needs
  // (agent-workflow-routes.ts). Grouped because their correctness is a claim
  // about the DevKit's contract rather than this platform's, and three of the
  // four derive their method list from `GUEST_ROUTE_EXPOSURE`.
  registerAgentWorkflowRoutes(agents, {
    broker: brokerOpts,
    uploadBytes: opts.uploadBytes ?? createMemoryUploadBytes(),
    ...omitUndefined({ guestFetch: opts.guestFetch }),
    ...omitUndefined({ adminDb: opts.adminDb }),
    ...omitUndefined({ workflowRateLimiter: opts.workflowRateLimiter }),
    ...omitUndefined({ workflowStartRateLimiter: opts.workflowStartRateLimiter }),
  });
  agents.get("/favicon.ico", handleAgentFavicon);
  agents.get("/assets/:path{.+}", handleClientAsset);
  // GET /:slug/ stays on the top-level app — Hono's mergePath("/:slug", "/")
  // collapses the trailing slash, breaking the route.
  app.route("/:slug", agents);
  app.get("/:slug/", slugMw, handleAgentPage);

  bindFetchEnv(app, {
    store: opts.store,
    secrets,
    ...omitUndefined({ auth: opts.auth }),
    ...omitUndefined({ keyVerifier: opts.keyVerifier }),
    // Same default posture as secrets: tests build orchestrators without a
    // platform database, where in-process exclusion is exact. Wrapped so
    // taking the lock also drops this replica's cached view of the slug —
    // every mutation route read-modify-writes, and the cache is what makes a
    // correctly-serialized write compute its merge from a stale base (see
    // createMutationLock).
    slugLock: createMutationLock(opts.slugLock ?? localSlugLock, opts.store),
  });

  const { injectWebSocket } = createWsUpgrades({
    // Upgrades on /:slug/websocket resolve the live sandbox (the
    // long-living endpoint redirects to its session URL), which needs the
    // same dependencies the client-config broker uses.
    broker: brokerOpts,
    // Upgrades on /:slug/platform-socket are a deployed guest's own RPC
    // transport. It takes the APP because a frame is dispatched back through
    // it as a real request — see `platform-socket-handler.ts` for why that
    // rather than a second dispatch over the five handlers.
    platformSocket: {
      app,
      store: opts.store,
      ...omitUndefined({ isDraining: opts.isDraining }),
    },
  });

  return { app, injectWebSocket };
}
