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
 * Supabase: workspaces/chats, the bundle store, Vault secrets, the slug
 * mutation lock, and — critically — the slug epochs, which are how a
 * Publish here reaches the agent service's resident sandboxes (they rebuild
 * on the epoch mismatch at the next session start; see platform-epoch.ts).
 * The `slots` binding is this service's own (always-empty) cache: deploy's
 * local `terminateSlot` is a no-op here by design.
 */

import type { AppDatabases } from "aai-server/app-database";
import { applyPlatformMiddleware } from "aai-server/app-middleware";
import type { ChatStore } from "aai-server/chat-store";
import { createMemorySlugEpochs, type SlugEpochs } from "aai-server/platform-epoch";
import { createMutationLock, localSlugLock, type SlugMutationLock } from "aai-server/platform-lock";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { createSlotCache } from "aai-server/sandbox-slots";
import { createMemorySecretStore, type SecretStore } from "aai-server/secret-store";
import type { BundleStore } from "aai-server/store-types";
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
  /** Named secret storage; the storage routes read/write app-db credentials. */
  secrets?: SecretStore;
  /** Per-app database provisioning; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  /** Cross-service slug mutation lock — MUST be the shared Postgres lock in production. */
  slugLock?: SlugMutationLock;
  /** Cross-service invalidation epochs — MUST be the shared Postgres store in production. */
  slugEpochs?: SlugEpochs;
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

  app.get("/health", (c) =>
    opts.isDraining?.() ? c.json({ status: "draining" }, 503) : c.json({ status: "ok" }),
  );

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
  app.get("/studio/", (c) => c.redirect("/", 302));

  const bindings: StudioHonoEnv["Bindings"] = {
    // This service runs no voice sandboxes; an empty cache makes the shared
    // mutation cores' local terminateSlot/restartSlotSandbox calls no-ops,
    // while the epoch bump they also perform reaches the agent service.
    slots: createSlotCache(),
    store: opts.store,
    workspaces: opts.workspaces,
    chats: opts.chats,
    secrets: opts.secrets ?? createMemorySecretStore(),
    ...(opts.appDb && { appDb: opts.appDb }),
    // Wrapped exactly as the agent service wraps it: holding the lock must
    // also drop this replica's cached view of the slug, or a mutation
    // read-modify-writes off a pre-lock snapshot (see createMutationLock).
    slugLock: createMutationLock(opts.slugLock ?? localSlugLock, opts.store),
    slugEpochs: opts.slugEpochs ?? createMemorySlugEpochs(),
  };

  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });

  return { app, dispose: studioRoutes.dispose };
}
