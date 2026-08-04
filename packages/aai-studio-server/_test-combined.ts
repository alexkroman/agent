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
import { isStudioPath } from "aai-server/studio-proxy";
import { createTestOrchestrator, type TestFetch } from "aai-server/test-utils";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { createStudioApp } from "./studio-app.ts";

/** Combined-mode harness: agent orchestrator + studio app in one fetch. */
type CombinedOverrides = Partial<OrchestratorOpts> & {
  // The studio stores are the studio's, not the orchestrator's — see
  // StudioHonoEnv. Accepted here because this harness builds both apps.
  workspaces?: WorkspaceStore;
  chats?: ChatStore;
};

export async function createTestCombined(overrides: CombinedOverrides = {}) {
  const secrets = overrides.secrets ?? createMemorySecretStore();
  const orch = await createTestOrchestrator({ ...overrides, secrets });
  const { app: studioApp } = createStudioApp({
    store: overrides.store ?? orch.store,
    workspaces: overrides.workspaces ?? orch.workspaces,
    chats: overrides.chats ?? orch.chats,
    // The orchestrator's paired event bus — workspace writes through
    // `orch.workspaces` feed the studio's SSE route, like production.
    events: overrides.events ?? orch.events,
    secrets,
    ...(overrides.auth && { auth: overrides.auth }),
    ...(overrides.appDb && { appDb: overrides.appDb }),
    ...(overrides.slugLock && { slugLock: overrides.slugLock }),
  });
  const fetch: TestFetch = async (input, init) => {
    const path = typeof input === "string" ? input : new URL(String(input)).pathname;
    const pathname = new URL(path, "http://combined.test").pathname;
    return isStudioPath(pathname) ? studioApp.request(input, init) : orch.fetch(input, init);
  };
  return { ...orch, fetch, studioApp };
}
