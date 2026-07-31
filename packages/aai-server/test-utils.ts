// Copyright 2025 the AAI authors. MIT license.

import { createMemoryVector } from "@alexkroman1/aai/runtime";
import { type ChatStore, createMemoryChatStore } from "./chat-store.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { type AgentSlot, createSlotCache } from "./sandbox-slots.ts";
import { type AgentMetadata, AgentMetadataSchema } from "./schemas.ts";
import { agentEnvSecretName, appDbSecretName, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspace-store.ts";

export const VALID_ENV: Record<string, string> = {};

/**
 * Sync in-memory BundleStore for tests. No encryption — stores env as plain
 * JSON. When a SecretStore is passed, `deleteAgent` sweeps the agent's secret
 * names like the real store does (the delete route relies on that contract).
 */
export function createTestStore(secrets?: SecretStore): BundleStore {
  const objects = new Map<string, string>();

  function objectKey(slug: string, file: string): string {
    return `agents/${slug}/${file}`;
  }

  function deleteByPrefix(prefix: string) {
    for (const key of objects.keys()) {
      if (key.startsWith(prefix)) objects.delete(key);
    }
  }

  function readManifest(slug: string): Record<string, unknown> | null {
    const data = objects.get(objectKey(slug, "manifest.json"));
    return data !== undefined ? JSON.parse(data) : null;
  }

  function writeManifest(slug: string, manifest: Record<string, unknown>) {
    objects.set(objectKey(slug, "manifest.json"), JSON.stringify(manifest));
  }

  return {
    putAgent(bundle) {
      deleteByPrefix(`agents/${bundle.slug}/`);
      writeManifest(bundle.slug, {
        slug: bundle.slug,
        env: bundle.env,
        credential_hashes: bundle.credential_hashes,
      });
      objects.set(objectKey(bundle.slug, "worker.js"), bundle.worker);
      for (const [filePath, content] of Object.entries(bundle.clientFiles)) {
        objects.set(objectKey(bundle.slug, `client/${filePath}`), content);
      }
      objects.set(objectKey(bundle.slug, "config.json"), JSON.stringify(bundle.agentConfig));
      return Promise.resolve();
    },

    getManifest(slug) {
      const raw = readManifest(slug);
      if (!raw) return Promise.resolve(null);
      const parsed = AgentMetadataSchema.safeParse(raw);
      return Promise.resolve(parsed.success ? (parsed.data as AgentMetadata) : null);
    },

    getWorkerCode(slug) {
      return Promise.resolve(objects.get(objectKey(slug, "worker.js")) ?? null);
    },

    getClientFile(slug, filePath) {
      return Promise.resolve(objects.get(objectKey(slug, `client/${filePath}`)) ?? null);
    },

    async deleteAgent(slug) {
      deleteByPrefix(`agents/${slug}/`);
      await secrets?.delete(agentEnvSecretName(slug));
      await secrets?.delete(appDbSecretName(slug));
    },

    getEnv(slug) {
      const raw = readManifest(slug);
      return Promise.resolve((raw?.env as Record<string, string>) ?? null);
    },

    putEnv(slug, env) {
      const raw = readManifest(slug);
      if (!raw) return Promise.reject(new Error(`Agent ${slug} not found`));
      raw.env = env;
      writeManifest(slug, raw);
      return Promise.resolve();
    },

    getAgentConfig(slug) {
      const data = objects.get(objectKey(slug, "config.json"));
      if (data == null) return Promise.resolve(null);
      try {
        return Promise.resolve(JSON.parse(data));
      } catch {
        return Promise.resolve(null);
      }
    },
  };
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
  allowedHosts: [] as string[],
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
}> {
  const store = createTestStore(overrides.secrets);
  const workspaces = createMemoryWorkspaceStore();
  const chats = createMemoryChatStore();
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
    workspaces,
    chats,
    defaultVector: (slug) => createMemoryVector({ namespace: slug }),
    // The real default spins a Modal sandbox to read the worker's
    // `__aaiConfig` self-description; tests answer with the standard config.
    inspect: async () => TEST_AGENT_CONFIG,
    ...overrides,
  });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, workspaces, chats };
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

// Sandbox-VM fakes shared with the aai-studio-server package tests
// (cross-package imports may not reach `_`-internal modules directly).
export { createTestConn, makeWarm, writeResponse } from "./_sandbox-vm-test-utils.ts";
