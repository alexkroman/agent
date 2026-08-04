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
 * - `GET  /:slug/favicon.ico`    — agent page favicon (custom or default)
 * - `GET  /:slug/assets/:path`   — client static assets
 * - `DELETE /:slug/`             — owner: delete agent
 * - `GET/PUT/DELETE /:slug/secret` — owner: manage secrets
 * - `GET/POST/DELETE /:slug/storage` — owner: per-app database storage
 * - `WS   /:slug/websocket`     — the long-living programmatic endpoint:
 *   upgrades are redirected (302) to the agent's live sandbox session URL
 *
 * Auth: `authMw` validates API key; `existingOwnerMw` verifies slug ownership.
 * Slugs: `[a-z0-9][a-z0-9_-]*[a-z0-9]` — enforced by regex for multi-tenant isolation.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppDatabases } from "./app-database.ts";
import { addHealthRoute, applyPlatformMiddleware, bindFetchEnv } from "./app-middleware.ts";
import { handleAgentClientConfig } from "./client-config-handler.ts";
import { resolveHarnessPath } from "./constants.ts";
import type { HonoEnv } from "./context.ts";
import { handleDelete } from "./delete.ts";
import { type BundleInspector, handleDeployNew } from "./deploy.ts";
import { gzipRequestMw, MAX_INFLATED_BODY_BYTES } from "./gzip-request.ts";
import { authMw, existingOwnerMw, slugMw } from "./middleware.ts";
import { createWsUpgrades } from "./orchestrator-ws.ts";
import type { PlatformEvents } from "./platform-events.ts";
import { createMutationLock, localSlugLock, type SlugMutationLock } from "./platform-lock.ts";
import type { SandboxRegistry } from "./sandbox-registry.ts";
import { type ResolveSandboxOpts, watchAgentInvalidation } from "./sandbox-resolve.ts";
import type { SlotCache } from "./sandbox-slots.ts";
import { currentHarnessImageTag, describeBundle } from "./sandbox-vm.ts";
import {
  DeployBodySchema,
  SecretKeySchema,
  SecretUpdatesSchema,
  SLUG_PATTERN_SOURCE,
} from "./schemas.ts";
import { handleSecretDelete, handleSecretList, handleSecretSet } from "./secret-handler.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import {
  handleStorageDisable,
  handleStorageEnable,
  handleStorageStatus,
} from "./storage-handler.ts";
import type { BundleStore } from "./store-types.ts";
import { createStudioProxy, isStudioPath } from "./studio-proxy.ts";
import type { StudioAuth } from "./supabase-auth.ts";
import {
  handleAgentFavicon,
  handleAgentHealth,
  handleAgentPage,
  handleClientAsset,
} from "./transport-websocket.ts";

export type OrchestratorOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Named secret storage (Supabase Vault in production, memory in tests). */
  secrets?: SecretStore;
  /** Browser-session auth; absent means raw-API-key bearers only. */
  auth?: StudioAuth;
  /** Per-app database provisioning; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
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
   * Cross-replica sandbox registry (see sandbox-registry.ts): residents are
   * registered/heartbeated, and cold brokers route to live peer sandboxes
   * before spawning duplicates. Optional for tests; single-replica
   * compositions lose nothing without it.
   */
  registry?: SandboxRegistry;
  /** Allowed CORS origins. Defaults to `["*"]` (any origin). */
  allowedOrigins?: string[];
  /**
   * Split deployment: base URL of the standalone studio service. When set,
   * the studio surface is reverse-proxied there (see studio-proxy.ts)
   * instead of mounted in-process, keeping one public origin.
   */
  studioUpstream?: string;
  /** Test seam for the studio proxy's outbound fetch. */
  studioProxyFetch?: typeof globalThis.fetch;
  /**
   * Extracts an agent config from an uploaded worker bundle. Defaults to
   * sandboxed `describeBundle`; injectable so tests don't need Modal.
   */
  inspect?: BundleInspector;
  /**
   * True once shutdown has begun. Fails `/health` so the platform's proxy
   * stops routing here. (Upgrades on `/:slug/websocket` are pure handshake
   * redirects to the sandbox — nothing long-lived starts here, so there is
   * nothing to refuse while draining.)
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

  addHealthRoute(app, opts.isDraining);

  // The studio surface. This app never serves it in-process anymore — the
  // studio is its own package/service (aai-studio-server). Two modes here:
  // reverse-proxy to the studio service (split deployment, `studioUpstream`
  // set — keeps ONE public origin, which the preview iframe's SAMEORIGIN
  // framing requires), or agent-only (no studio surface; the combined
  // single-process composition lives in aai-studio-server's entry, which
  // dispatches between this app and the studio app). `studio` and
  // `studio-assets` are reserved slugs (RESERVED_SLUGS) so no agent route
  // can shadow the namespace in any mode.
  if (opts.studioUpstream) {
    const proxy = createStudioProxy(opts.studioUpstream, opts.studioProxyFetch);
    // Registered from the shared predicate, so this list can never drift
    // from the combined dispatcher's.
    app.use("*", (c, next) => (isStudioPath(c.req.path) ? proxy(c) : next()));
  } else {
    app.get("/", (c) => c.json({ service: "aai-agent", studio: "not served by this deployment" }));
  }

  // Cap the on-the-wire deploy body (compressed or not) before anything
  // buffers it. gzipRequestMw separately caps the DECOMPRESSED size, so a
  // zip bomb is bounded on both axes.
  const deployBodyLimit = bodyLimit({
    maxSize: MAX_INFLATED_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });

  // Config extraction loads the uploaded worker in a throwaway guest
  // sandbox and reads its `__aaiConfig` self-description — tenant code
  // never runs on the host.
  const inspect: BundleInspector =
    opts.inspect ??
    ((workerCode) => describeBundle({ harnessPath: resolveHarnessPath(), workerCode }));

  // Deploys record the harness image they ran against (per-deploy image
  // pinning — see currentHarnessImageTag in sandbox-vm.ts).
  const harnessImageTag = (): Promise<string | null> =>
    currentHarnessImageTag(resolveHarnessPath());

  app.post(
    "/deploy",
    authMw,
    deployBodyLimit,
    gzipRequestMw,
    zValidator("json", DeployBodySchema),
    (c) => handleDeployNew(c, inspect, harnessImageTag),
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
    ...(opts.registry && { registry: opts.registry }),
    ...(opts.appDb && { appDb: opts.appDb }),
  };

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
  // Per-app database storage — same auth posture as the secret routes.
  agents.get("/storage", existingOwnerMw, handleStorageStatus);
  agents.post("/storage", existingOwnerMw, handleStorageEnable);
  agents.delete("/storage", existingOwnerMw, handleStorageDisable);

  agents.get("/health", handleAgentHealth);
  // Session broker: name/greeting plus the live sandbox session URL (boots
  // the sandbox on first request). Same auth posture as the page and the
  // session endpoint: none.
  agents.get("/client-config", (c) => handleAgentClientConfig(c, brokerOpts));
  agents.get("/favicon.ico", handleAgentFavicon);
  agents.get("/assets/:path{.+}", handleClientAsset);
  // GET /:slug/ stays on the top-level app — Hono's mergePath("/:slug", "/")
  // collapses the trailing slash, breaking the route.
  app.route("/:slug", agents);
  app.get("/:slug/", slugMw, handleAgentPage);

  bindFetchEnv(app, {
    store: opts.store,
    secrets,
    ...(opts.auth && { auth: opts.auth }),
    ...(opts.registry && { registry: opts.registry }),
    ...(opts.appDb && { appDb: opts.appDb }),
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
  });

  return { app, injectWebSocket };
}
