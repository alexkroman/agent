// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser studio as its own HTTP app.
 *
 * The orchestrator does NOT mount these routes — it serves the agent surface
 * only. This app is a peer to it, and `index.ts` (the composition root every
 * deployment runs) dispatches between the two by path: `/`, `/favicon.ico`,
 * `/studio/*`, and `/studio-assets/*` here, everything else there. Keeping the
 * two as separate Hono apps rather than one route tree is what lets each carry
 * its own bindings injection, and it is the seam a future split deployment
 * would cut along.
 *
 * Both run in ONE process on one hostname, so the preview iframe's same-origin
 * framing works and browser clients see a single host.
 *
 * Everything the studio shares with the agent service goes through
 * Supabase: workspaces/chats, the agents table + blob store, Vault secrets,
 * the slug mutation lock, and the Realtime change streams. A Publish here
 * reaches the agent service's resident sandboxes through the agents row's
 * change stream (their watchers retire on the version mismatch within
 * seconds; see sandbox-resolve.ts).
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { ApiKeyVerifier } from "aai-server/api-key-verify";
import type { AppDatabases } from "aai-server/app-database";
import { addHealthRoute, applyPlatformMiddleware, bindFetchEnv } from "aai-server/app-middleware";
import type { ChatStore } from "aai-server/chat-store";
import { createMemoryPlatformEvents, type PlatformEvents } from "aai-server/platform-events";
import { createMutationLock, localSlugLock, type SlugMutationLock } from "aai-server/platform-lock";
import { createMemorySecretStore, type SecretStore } from "aai-server/secret-store";
import type { BundleStore } from "aai-server/store-types";
import type { StudioAuth } from "aai-server/supabase-auth";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { Hono } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import type { PreviewQueue } from "./studio-preview-queue.ts";
import type { StudioRateLimiters } from "./studio-rate-limit.ts";
import { createStudioRoutes } from "./studio-routes.ts";
import type { StudioSessionRegistry } from "./studio-session-registry.ts";
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
  /**
   * Verifies raw API-key bearers against AssemblyAI. The studio needs it as
   * much as the agent surface does: project-create and the session broker key
   * their scope off the bearer and each spawn a Modal sandbox, so an
   * unverified bearer is unauthenticated compute.
   */
  keyVerifier?: ApiKeyVerifier;
  /** Per-app database provisioning; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  /** Cross-service slug mutation lock — MUST be the shared Postgres lock in production. */
  slugLock?: SlugMutationLock;
  studioRateLimiters?: StudioRateLimiters;
  /**
   * Cross-replica studio session registry + this replica's identity, so one
   * project gets ONE coding-agent sandbox fleet-wide rather than one per
   * replica (studio-session-registry.ts). Both or neither.
   */
  studioSessionRegistry?: StudioSessionRegistry;
  /**
   * Durable preview-deploy queue (studio-preview-queue.ts): pgmq over the
   * platform database in production, `createMemoryPreviewQueue()` in a single
   * process. REQUIRED — the composition root picks one, and nothing below it
   * may substitute a different tier (see `StudioSessionBrokerOptions
   * .previewQueue`).
   */
  previewQueue: PreviewQueue;
  replicaId?: string;
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

  addHealthRoute(app, opts.isDraining, opts.events);

  app.get("/", handleStudioPage);
  // v0-style project URLs (`/studio/chat/<project>`) serve the same shell —
  // the client reads the project from the path. Registered before the API
  // mount so the page wins over the `/studio` router (which has no route
  // here, but does hang auth middleware under `/studio/*`).
  app.get("/studio/chat/:project", handleStudioPage);
  app.get("/favicon.ico", handleStudioFavicon);
  app.get("/studio-assets/:path{.+}", handleStudioClientAsset);
  const studioRoutes = createStudioRoutes({
    ...omitUndefined({ rateLimiters: opts.studioRateLimiters }),
    ...omitUndefined({ sessionRegistry: opts.studioSessionRegistry }),
    previewQueue: opts.previewQueue,
    ...(opts.replicaId && { replicaId: opts.replicaId }),
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
    ...omitUndefined({ auth: opts.auth }),
    ...omitUndefined({ keyVerifier: opts.keyVerifier }),
    ...omitUndefined({ appDb: opts.appDb }),
    // Wrapped exactly as the agent service wraps it: holding the lock must
    // also drop this replica's cached view of the slug, or a mutation
    // read-modify-writes off a pre-lock snapshot (see createMutationLock).
    slugLock: createMutationLock(opts.slugLock ?? localSlugLock, opts.store),
  });

  return { app, dispose: studioRoutes.dispose };
}
