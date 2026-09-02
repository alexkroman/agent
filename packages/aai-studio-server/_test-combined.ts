// Copyright 2026 the AAI authors. MIT license.
/**
 * Test double of the combined composition (see index.ts): the agent
 * orchestrator and the studio app sharing one set of stores, dispatched by
 * path exactly like the combined entry's fetch. Drop-in for the old
 * `createTestOrchestrator` in studio tests, from when the orchestrator
 * mounted the studio routes in-process.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { ChatStore } from "aai-server/chat-store";
import type { OrchestratorOpts } from "aai-server/orchestrator";
import { createMemorySecretStore } from "aai-server/secret-store";
import { isStudioPath } from "aai-server/studio-paths";
import { createTestOrchestrator, type TestFetch } from "aai-server/test-utils";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { createStudioApp, type StudioAppOpts } from "./studio-app.ts";
import { createMemoryPreviewQueue } from "./studio-preview-queue.ts";

/** Combined-mode harness: agent orchestrator + studio app in one fetch. */
type CombinedOverrides = Partial<OrchestratorOpts> & {
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
  /** The GitHub App + a fake GitHub, for the sync suite. */
  githubApp?: StudioAppOpts["githubApp"];
  githubFetch?: StudioAppOpts["githubFetch"];
};

export async function createTestCombined(overrides: CombinedOverrides = {}) {
  const secrets = overrides.secrets ?? createMemorySecretStore();
  const orch = await createTestOrchestrator({ ...overrides, secrets });
  const { app: studioApp, dispose: disposeStudio } = createStudioApp({
    store: overrides.store ?? orch.store,
    workspaces: overrides.workspaces ?? orch.workspaces,
    chats: overrides.chats ?? orch.chats,
    // The orchestrator's paired event bus — workspace writes through
    // `orch.workspaces` feed the studio's SSE route, like production.
    events: overrides.events ?? orch.events,
    secrets,
    ...omitUndefined({ auth: overrides.auth }),
    ...omitUndefined({ keyVerifier: overrides.keyVerifier }),
    ...omitUndefined({ slugLock: overrides.slugLock }),
    ...omitUndefined({ studioRateLimiters: overrides.studioRateLimiters }),
    ...omitUndefined({ githubApp: overrides.githubApp, githubFetch: overrides.githubFetch }),
    ...omitUndefined({
      studioSessionRegistry: overrides.studioSessionRegistry,
    }),
    // A test harness IS a composition root, so it makes the choice the real one
    // makes: one process, so an in-memory queue — explicitly, never by a
    // downstream `??`.
    previewQueue: overrides.previewQueue ?? createMemoryPreviewQueue(),
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
