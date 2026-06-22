// Copyright 2025 the AAI authors. MIT license.

import type { Kv } from "@alexkroman1/aai";
import { createMemoryVector } from "@alexkroman1/aai/runtime";
import { createStorage, type Storage } from "unstorage";
import { vi } from "vitest";
import { registry } from "./metrics.ts";
import { createOrchestrator } from "./orchestrator.ts";
import type { AgentSlot } from "./sandbox.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { AgentMetadataSchema } from "./schemas.ts";
import type { BundleStore } from "./store-types.ts";

export { createSlotCache } from "./sandbox-slots.ts";

// ── Metric-reading helpers (canonical versions for tests) ───────────────

type MetricEntry = { labels?: Record<string, string>; value?: number; count?: number };

function getMetric(
  name: string,
): { hashMap?: Record<string, MetricEntry>; collect?: () => void } | null {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  return (registry.getSingleMetric(name) as any) ?? null;
}

function entryMatches(entry: MetricEntry, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(([k, v]) => entry.labels?.[k] === v);
}

/** Read a counter's value at the given label combination. Returns 0 if unset. */
export function counterValue(name: string, labels: Record<string, string> = {}): number {
  const m = getMetric(name);
  if (!m?.hashMap) return 0;
  // prom-client stores unlabeled metrics under the "" hash key; read it
  // directly rather than returning the first arbitrary entry from the loop.
  if (Object.keys(labels).length === 0) return m.hashMap[""]?.value ?? 0;
  for (const entry of Object.values(m.hashMap)) {
    if (entryMatches(entry, labels)) return entry.value ?? 0;
  }
  return 0;
}

/**
 * Read a gauge's value (unlabeled or matched). Returns 0 if unset.
 *
 * Triggers any registered `collect()` callback so pull-based gauges are
 * refreshed before the read.
 */
export function gaugeValue(name: string, labels: Record<string, string> = {}): number {
  getMetric(name)?.collect?.();
  return counterValue(name, labels);
}

/** Read the count of observations on a histogram. Returns 0 if no observations. */
export function histogramCount(name: string, labels?: Record<string, string>): number {
  const m = getMetric(name);
  if (!m?.hashMap) return 0;
  const entries = Object.values(m.hashMap);
  if (!labels) return entries.reduce((sum, e) => sum + (e.count ?? 0), 0);
  return entries.find((e) => entryMatches(e, labels))?.count ?? 0;
}

/** In-memory mock KV store backed by a Map. All methods are vi.fn() spies. */
export function createMockKv(): Kv {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null) as Kv["get"],
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

export const VALID_ENV: Record<string, string> = {};

/** Sync in-memory BundleStore for tests. No encryption — stores env as plain JSON. */
export function createTestStore(): BundleStore {
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
      return Promise.resolve(parsed.success ? parsed.data : null);
    },

    getWorkerCode(slug) {
      return Promise.resolve(objects.get(objectKey(slug, "worker.js")) ?? null);
    },

    getClientFile(slug, filePath) {
      return Promise.resolve(objects.get(objectKey(slug, `client/${filePath}`)) ?? null);
    },

    deleteAgent(slug) {
      deleteByPrefix(`agents/${slug}/`);
      return Promise.resolve();
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

export function createTestStorage(): Storage {
  return createStorage();
}

export function makeSlot(overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug: "test-agent",
    keyHash: "test-key-hash",
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
    agentConfig: TEST_AGENT_CONFIG,
    ...overrides,
  });
}

export type TestFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

export async function createTestOrchestrator(): Promise<{
  fetch: TestFetch;
  store: BundleStore;
  storage: Storage;
}> {
  const store = createTestStore();
  const storage = createTestStorage();
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
    storage,
    defaultVector: (slug) => createMemoryVector({ namespace: slug }),
  });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, storage };
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
  await fetch(`/${slug}/deploy`, {
    method: "POST",
    headers: authHeaders(key),
    body: deployBody(),
  });
}
