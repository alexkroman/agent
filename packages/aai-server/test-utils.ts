// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { createMemoryAgentRows } from "./agent-store.ts";
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
} from "./platform-events.ts";
import { type AgentSlot, createSlotCache } from "./sandbox-slots.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspace-store.ts";

// Deploys preflight the agent's required credentials against the merged env
// (see `missingCredentials` in deploy.ts); the default S2S test config needs
// the AssemblyAI key, so the standard test env carries one.
export const VALID_ENV: Record<string, string> = { ASSEMBLYAI_API_KEY: "test-key" };

/**
 * In-memory BundleStore for tests: the REAL bundle store over unstorage's
 * memory driver, in-memory agent rows, and an in-memory SecretStore — so
 * tests exercise the same content-addressed blob + row-commit code paths
 * production runs. When a SecretStore is passed, `deleteAgent` sweeps the
 * agent's secret names like production does (the delete route relies on
 * that contract).
 */
export function createTestStore(secrets?: SecretStore, events?: MemoryPlatformEvents): BundleStore {
  const agents = createMemoryAgentRows();
  return createBundleStore(createStorage(), {
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

/** Default agent config for tests. */
export const TEST_AGENT_CONFIG = {
  name: "test-agent",
  systemPrompt: "Test",
  greeting: "",
  toolSchemas: [],
};

export function deployBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    env: VALID_ENV,
    worker:
      'export default { name: "test-agent", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
    clientFiles: {
      "index.html":
        // biome-ignore lint/security/noSecrets: HTML template, not a secret
        '<!DOCTYPE html><html><body><script type="module" src="./assets/index.js"></script></body></html>',
      "assets/index.js": 'console.log("c");',
    },
    ...overrides,
  });
}

export type TestFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

export async function createTestOrchestrator(
  overrides: Partial<Parameters<typeof createOrchestrator>[0]> = {},
): Promise<{
  fetch: TestFetch;
  store: BundleStore;
  workspaces: WorkspaceStore;
  chats: ChatStore;
  events: PlatformEvents;
}> {
  // Stores + event bus are a PAIR (see platform-events.ts): the
  // orchestrator's event-driven sandbox invalidation and the studio's SSE
  // pushes only fire when row writes emit.
  const memoryEvents = createMemoryPlatformEvents();
  const store = createTestStore(overrides.secrets, memoryEvents);
  const workspaces = withWorkspaceEvents(createMemoryWorkspaceStore(), memoryEvents.emitWorkspace);
  const chats = withChatEvents(createMemoryChatStore(), memoryEvents.emitChat);
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
    events: memoryEvents.events,
    // The real default spins a Modal sandbox to read the worker's
    // `__aaiConfig` self-description; tests answer with the standard config.
    inspect: async () => TEST_AGENT_CONFIG,
    ...overrides,
  });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, workspaces, chats, events: memoryEvents.events };
}

/** Standard auth + JSON headers for test requests. */
export function authHeaders(key = "key1"): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/** Convenience: authenticated JSON request via test fetch. */
export async function authFetch(
  fetch: TestFetch,
  path: string,
  opts: { method?: string; key?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(path, {
    method: opts.method ?? "POST",
    headers: authHeaders(opts.key),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

export async function deployAgent(
  fetch: TestFetch,
  slug = "my-agent",
  key = "key1",
): Promise<void> {
  await fetch("/deploy", {
    method: "POST",
    headers: authHeaders(key),
    body: deployBody({ slug }),
  });
}
