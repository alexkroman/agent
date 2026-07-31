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

import { createMemoryVector, type Vector } from "@alexkroman1/aai/runtime";
import type { AppDatabases } from "aai-server/app-database";
import { applyPlatformMiddleware } from "aai-server/app-middleware";
import type { ChatStore } from "aai-server/chat-store";
import type { HonoEnv } from "aai-server/context";
import { createMemorySlugEpochs, type SlugEpochs } from "aai-server/platform-epoch";
import { localSlugLock, type SlugMutationLock } from "aai-server/platform-lock";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { createSlotCache } from "aai-server/sandbox-slots";
import { createMemorySecretStore, type SecretStore } from "aai-server/secret-store";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { Hono } from "hono";
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

export function createStudioApp(opts: StudioAppOpts): { app: Hono<HonoEnv> } {
  const app = new Hono<HonoEnv>();
  applyPlatformMiddleware(app, opts.allowedOrigins);

  app.get("/health", (c) =>
    opts.isDraining?.() ? c.json({ status: "draining" }, 503) : c.json({ status: "ok" }),
  );

  app.get("/", handleStudioPage);
  app.get("/favicon.ico", handleStudioFavicon);
  app.get("/studio-assets/:path{.+}", handleStudioClientAsset);
  app.route(
    "/studio",
    createStudioRoutes({
      pool: opts.pool,
      ...(opts.studioRateLimiters && { rateLimiters: opts.studioRateLimiters }),
    }),
  );
  app.get("/studio/", (c) => c.redirect("/", 302));

  const bindings: HonoEnv["Bindings"] = {
    // This service runs no voice sandboxes; an empty cache makes the shared
    // mutation cores' local terminateSlot/restartSlotSandbox calls no-ops,
    // while the epoch bump they also perform reaches the agent service.
    slots: createSlotCache(),
    store: opts.store,
    workspaces: opts.workspaces,
    chats: opts.chats,
    secrets: opts.secrets ?? createMemorySecretStore(),
    ...(opts.appDb && { appDb: opts.appDb }),
    slugLock: opts.slugLock ?? localSlugLock,
    slugEpochs: opts.slugEpochs ?? createMemorySlugEpochs(),
    // Never used by studio routes (it belongs to the agent vector route,
    // required by the shared Bindings shape) — a memory factory keeps the
    // studio service free of Pinecone credentials.
    defaultVector: (slug: string): Vector => createMemoryVector({ namespace: slug }),
  };

  const original = app.fetch.bind(app);
  app.fetch = (req: Request, env?: Record<string, unknown>) =>
    original(req, { ...bindings, ...env });

  return { app };
}
