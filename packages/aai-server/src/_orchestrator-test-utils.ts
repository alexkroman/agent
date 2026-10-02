// Copyright 2025 the AAI authors. MIT license.

/**
 * An in-memory platform for specs: the real bundle store and orchestrator over
 * memory stores and a memory event bus.
 */

import path from "node:path";
import { afterAll, onTestFinished } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { type ChatStore, createMemoryChatStore } from "./chat-store.ts";
import { createOrchestrator } from "./orchestrator.ts";
import {
  createMemoryPlatformEvents,
  type MemoryPlatformEvents,
  type PlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform/events.ts";
import { type AgentSlot, createSlotCache } from "./sandbox/slots.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspace-store.ts";

// The default test worker is an S2S config, which resolves its provider
// credential from `ASSEMBLYAI_API_KEY`.
export const VALID_ENV: Record<string, string> = { ASSEMBLYAI_API_KEY: "test-key" };

/**
 * In-memory BundleStore for tests: the REAL bundle store over the in-memory
 * blob storage, in-memory agent rows, and an in-memory SecretStore — so
 * tests exercise the same content-addressed blob + row-commit code paths
 * production runs. When a SecretStore is passed, `deleteAgent` sweeps the
 * agent's secret names like production does (the delete route relies on
 * that contract).
 */
export function createTestStore(secrets?: SecretStore, events?: MemoryPlatformEvents): BundleStore {
  const agents = createMemoryAgentRows();
  return createBundleStore(createMemoryBlobStorage(), {
    secrets: secrets ?? createMemorySecretStore(),
    // Paired with a memory event bus when given, so agents-row writes notify
    // watchers exactly like production's postgres_changes stream.
    agents: events ? withAgentEvents(agents, events.emitAgent) : agents,
  });
}

export function makeSlot(overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug: "test-agent",
    ...overrides,
  };
}

export type TestFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

/**
 * `createTestOrchestrator`'s default `clientDir`: a path with no browser client
 * in it, so the default-client fallbacks answer "not built" (404/500). A test of
 * the REAL fallback passes `clientDir: defaultClientDir()` and imports
 * `@alexkroman1/aai-ui/client-dir` itself: shipped source here never imports
 * aai-ui (see `createDefaultClientHandlers`).
 */
export const NO_CLIENT_DIR = path.join(import.meta.dirname, "no-default-client");

// Orchestrators built OUTSIDE a test (a `beforeAll` — the conformance suites
// share one and need its sweep across cases) are stopped with the file.
const fileScopedSweeps: (() => void)[] = [];
afterAll(() => {
  for (const stop of fileScopedSweeps.splice(0)) stop();
});

/**
 * Stop `stop` when whatever built it ends: the test, or else the file. An
 * orchestrator handed an `adminDb` runs a real queue pass every second, so one
 * left running ticks into the next test's fake and its recorded statements.
 */
function stopWithScope(stop: () => void): void {
  try {
    onTestFinished(stop);
  } catch {
    // Thrown outside a running test, which is exactly the file-scoped case.
    fileScopedSweeps.push(stop);
  }
}

export async function createTestOrchestrator(
  overrides: Partial<Parameters<typeof createOrchestrator>[0]> = {},
): Promise<{
  fetch: TestFetch;
  store: BundleStore;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  events: PlatformEvents;
}> {
  // Stores + event bus are a PAIR (see platform/events.ts): the
  // orchestrator's event-driven sandbox invalidation and the studio's SSE
  // pushes only fire when row writes emit.
  const memoryEvents = createMemoryPlatformEvents();
  const store = createTestStore(overrides.secrets, memoryEvents);
  const workspaces = withWorkspaceEvents(createMemoryWorkspaceStore(), memoryEvents.emitWorkspace);
  const chats = withChatEvents(createMemoryChatStore(), memoryEvents.emitChat);
  const { app, stopSweeps } = createOrchestrator({
    slots: createSlotCache(),
    store,
    events: memoryEvents.events,
    clientDir: NO_CLIENT_DIR,
    ...overrides,
  });
  stopWithScope(stopSweeps);
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, workspaces, chats, events: memoryEvents.events };
}
