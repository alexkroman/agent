// Copyright 2026 the AAI authors. MIT license.
/**
 * Test double of the combined composition (see index.ts): the agent
 * orchestrator and the studio app sharing one set of stores, dispatched by
 * path exactly like the combined entry's fetch. Drop-in for the old
 * `createTestOrchestrator` in studio tests, from when the orchestrator
 * mounted the studio routes in-process.
 */

import type { ChatStore } from "aai-server/chat-store";
import type { OrchestratorOpts } from "aai-server/orchestrator";
import { createMemorySecretStore } from "aai-server/secret-store";
import { isStudioPath } from "aai-server/studio-paths";
import { createTestOrchestrator, type TestFetch } from "aai-server/test-utils";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { createStudioApp, type StudioAppOpts } from "./studio-app.ts";

/** Combined-mode harness: agent orchestrator + studio app in one fetch. */
type CombinedOverrides = Omit<Partial<OrchestratorOpts>, "analytics"> & {
  // The studio stores are the studio's, not the orchestrator's — see
  // StudioHonoEnv. Accepted here because this harness builds both apps.
  workspaces?: WorkspaceStore;
  chats?: ChatStore;
  // Studio-only options. Forwarded so a test can assert they reach the
  // session broker: the routes pass each one through a conditional spread,
  // and with every option absent, omitting a key and passing it as
  // `undefined` are indistinguishable from outside.
  studioSessionRegistry?: StudioAppOpts["studioSessionRegistry"];
  previewQueue?: StudioAppOpts["previewQueue"];
  studioRateLimiters?: StudioAppOpts["studioRateLimiters"];
  replicaId?: string;
  /**
   * One analytics store, wired to BOTH surfaces the way production does — and
   * with the authority split production has: the agent orchestrator gets the
   * ingest secret (it accepts guest batches), the studio gets the store alone
   * (it only ever reads). The two `analytics` options have different shapes
   * for exactly that reason, which is why this key replaces the inherited one
   * rather than being passed through.
   */
  analytics?: StudioAppOpts["analytics"];
  /** Ingest secret for the AGENT surface; absent leaves `POST /analytics/ingest` 404ing. */
  analyticsIngestSecret?: string;
};

/**
 * The AGENT surface's analytics binding: the same store the studio reads,
 * plus the ingest secret only that surface has (it accepts guest batches).
 */
function agentAnalytics(
  overrides: CombinedOverrides,
): Partial<Pick<OrchestratorOpts, "analytics">> {
  if (!overrides.analytics) return {};
  const { analyticsIngestSecret: secret } = overrides;
  return {
    analytics: {
      store: overrides.analytics,
      ...(secret === undefined ? {} : { ingestSecret: secret }),
    },
  };
}

export async function createTestCombined(overrides: CombinedOverrides = {}) {
  const secrets = overrides.secrets ?? createMemorySecretStore();
  // Destructured out so the spread below cannot carry the STUDIO shape of
  // `analytics` (a bare store) into the orchestrator, which wants a binding.
  const { analytics, analyticsIngestSecret: _secret, ...orchestratorOverrides } = overrides;
  const orch = await createTestOrchestrator({
    ...orchestratorOverrides,
    secrets,
    ...agentAnalytics(overrides),
  });
  const { app: studioApp, dispose: disposeStudio } = createStudioApp({
    store: overrides.store ?? orch.store,
    workspaces: overrides.workspaces ?? orch.workspaces,
    chats: overrides.chats ?? orch.chats,
    // The orchestrator's paired event bus — workspace writes through
    // `orch.workspaces` feed the studio's SSE route, like production.
    events: overrides.events ?? orch.events,
    secrets,
    ...(overrides.auth && { auth: overrides.auth }),
    ...(overrides.keyVerifier && { keyVerifier: overrides.keyVerifier }),
    ...(overrides.appDb && { appDb: overrides.appDb }),
    ...(overrides.slugLock && { slugLock: overrides.slugLock }),
    ...(overrides.studioRateLimiters && { studioRateLimiters: overrides.studioRateLimiters }),
    ...(overrides.studioSessionRegistry && {
      studioSessionRegistry: overrides.studioSessionRegistry,
    }),
    ...(overrides.previewQueue && { previewQueue: overrides.previewQueue }),
    ...(analytics && { analytics }),
    ...(overrides.replicaId && { replicaId: overrides.replicaId }),
  });
  const fetch: TestFetch = async (input, init) => {
    const path = typeof input === "string" ? input : new URL(String(input)).pathname;
    const pathname = new URL(path, "http://combined.test").pathname;
    return isStudioPath(pathname) ? studioApp.request(input, init) : orch.fetch(input, init);
  };
  // `disposeStudio` releases the studio's per-project coding-agent sandboxes;
  // exposed so a test can assert the shutdown path rather than leaving the
  // only caller in production code.
  return { ...orch, fetch, studioApp, disposeStudio };
}
