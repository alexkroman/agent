// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser studio as a standalone service.
 *
 * `createOrchestrator` mounts these same routes in-process (the combined
 * mode `aai dev` and single-service deployments use). This module serves
 * them as their own HTTP app so the studio can run as a separate service
 * from the agent backend: studio chat turns are LLM-bound and bursty, voice
 * sessions are latency-sensitive and long-lived, and splitting them keeps
 * one workload's scaling and failures away from the other's.
 *
 * The public origin stays single: the agent service proxies `/`,
 * `/favicon.ico`, `/studio-assets/*`, and `/studio/*` here (see
 * studio-proxy.ts), so the preview iframe's same-origin framing keeps
 * working and browser clients see one host.
 *
 * Everything the studio shares with the agent service goes through
 * Supabase: workspaces/chats, the agents table + blob store, Vault secrets,
 * the slug mutation lock, and the Realtime change streams. A Publish here
 * reaches the agent service's resident sandboxes through the agents row's
 * change stream (their watchers retire on the version mismatch within
 * seconds; see sandbox-resolve.ts).
 */

import type { AppDatabases } from "aai-server/app-database";
import { addHealthRoute, applyPlatformMiddleware, bindFetchEnv } from "aai-server/app-middleware";
import type { ChatStore } from "aai-server/chat-store";
import { createMemoryPlatformEvents, type PlatformEvents } from "aai-server/platform-events";
import { createMutationLock, localSlugLock, type SlugMutationLock } from "aai-server/platform-lock";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { createMemorySecretStore, type SecretStore } from "aai-server/secret-store";
import type { BundleStore } from "aai-server/store-types";
import type { StudioAuth } from "aai-server/supabase-auth";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { Hono } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import type { StudioRateLimiters } from "./studio-rate-limit.ts";
import { createStudioRoutes } from "./studio-routes.ts";
import { handleStudioClientAsset, handleStudioFavicon, handleStudioPage } from "./studio-static.ts";

export type StudioAppOpts = {
  /** Bundle store — deploys write it, published-slug lookups read it. */
  store: BundleStore;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  /**
   * Workspace change notifications, paired with `workspaces` (the memory
   * store only notifies when service-config wrapped it). Defaults to an
   * emitter that never fires — the SSE route then only serves its initial
   * snapshot, which is all tests without a paired store can expect.
   */
  events?: PlatformEvents;
  /** Named secret storage; the storage routes read/write app-db credentials. */
  secrets?: SecretStore;
  /** Browser-session auth; absent means raw-API-key bearers only. */
  auth?: StudioAuth;
  /** Per-app database provisioning; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  /** Cross-service slug mutation lock — MUST be the shared Postgres lock in production. */
  slugLock?: SlugMutationLock;
  studioRateLimiters?: StudioRateLimiters;
  /** Warm harness pool for test_agent / deploy config extraction. */
  pool?: SandboxPool;
  allowedOrigins?: string[];
  isDraining?: () => boolean;
};

export function createStudioApp(opts: StudioAppOpts): {
  app: Hono<StudioHonoEnv>;
  /** Release the studio's per-project coding-agent sandboxes on shutdown. */
  dispose: () => Promise<void>;
} {
  const app = new Hono<StudioHonoEnv>();
  applyPlatformMiddleware(app, opts.allowedOrigins);

  addHealthRoute(app, opts.isDraining);

  app.get("/", handleStudioPage);
  // v0-style project URLs (`/studio/chat/<project>`) serve the same shell —
  // the client reads the project from the path. Registered before the API
  // mount so the page wins over the `/studio` router (which has no route
  // here, but does hang auth middleware under `/studio/*`).
  app.get("/studio/chat/:project", handleStudioPage);
  app.get("/favicon.ico", handleStudioFavicon);
  app.get("/studio-assets/:path{.+}", handleStudioClientAsset);
  const studioRoutes = createStudioRoutes({
    pool: opts.pool,
    ...(opts.studioRateLimiters && { rateLimiters: opts.studioRateLimiters }),
  });
  app.route("/studio", studioRoutes.routes);
  // Bare `/studio` and `/studio/` — send the browser to the studio page.
  app.get("/studio", (c) => c.redirect("/", 302));
  app.get("/studio/", (c) => c.redirect("/", 302));

  bindFetchEnv(app, {
    store: opts.store,
    workspaces: opts.workspaces,
    chats: opts.chats,
    events: opts.events ?? createMemoryPlatformEvents().events,
    secrets: opts.secrets ?? createMemorySecretStore(),
    ...(opts.auth && { auth: opts.auth }),
    ...(opts.appDb && { appDb: opts.appDb }),
    // Wrapped exactly as the agent service wraps it: holding the lock must
    // also drop this replica's cached view of the slug, or a mutation
    // read-modify-writes off a pre-lock snapshot (see createMutationLock).
    slugLock: createMutationLock(opts.slugLock ?? localSlugLock, opts.store),
  });

  return { app, dispose: studioRoutes.dispose };
}
