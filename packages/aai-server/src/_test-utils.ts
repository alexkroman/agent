// Copyright 2025 the AAI authors. MIT license.

import { sortAndPaginate } from "@alexkroman1/aai/kv";
import { type AgentMetadata, AgentMetadataSchema } from "./_schemas.ts";
import type { BundleStore } from "./bundle-store-tigris.ts";
import type { KvStore } from "./kv.ts";
import { createOrchestrator } from "./orchestrator.ts";
import type { AgentSlot } from "./sandbox.ts";
import { importScopeKey, type ScopeKey } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

type Scope = { keyHash: string; slug: string };

function scopedKey(ns: string, scope: Scope, key: string): string {
  return `${ns}:${scope.keyHash}:${scope.slug}:${key}`;
}

function scopePrefix(ns: string, scope: Scope): string {
  return `${ns}:${scope.keyHash}:${scope.slug}:`;
}

/** Iterate a Map, yielding [userKey, value] for entries matching the scoped prefix. */
function* entriesWithPrefix<V>(
  store: Map<string, V>,
  ns: string,
  scope: Scope,
  userPrefix = "",
): Generator<[string, V]> {
  const prefix = `${scopePrefix(ns, scope)}${userPrefix}`;
  const stripLen = scopePrefix(ns, scope).length;
  for (const [key, value] of store) {
    if (key.startsWith(prefix)) {
      yield [key.slice(stripLen), value];
    }
  }
}

export const VALID_ENV = {
  ASSEMBLYAI_API_KEY: "test-key",
};

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

  return {
    putAgent(bundle) {
      deleteByPrefix(`agents/${bundle.slug}/`);
      const manifest = {
        slug: bundle.slug,
        env: bundle.env,
        credential_hashes: bundle.credential_hashes,
      };
      objects.set(objectKey(bundle.slug, "manifest.json"), JSON.stringify(manifest));
      objects.set(objectKey(bundle.slug, "worker.js"), bundle.worker);
      for (const [filePath, content] of Object.entries(bundle.clientFiles)) {
        objects.set(objectKey(bundle.slug, `client/${filePath}`), content);
      }
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
      if (!raw) {
        return Promise.reject(new Error(`Agent ${slug} not found`));
      }
      raw.env = env;
      objects.set(objectKey(slug, "manifest.json"), JSON.stringify(raw));
      return Promise.resolve();
    },
  };
}

export function createTestScopeKey(): Promise<ScopeKey> {
  return importScopeKey("test-secret-for-tests-only");
}

export function makeSlot(overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug: "test-agent",
    keyHash: "test-key-hash",
    ...overrides,
  };
}

export function deployBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    env: VALID_ENV,
    worker: "console.log('w');",
    clientFiles: {
      "index.html":
        '<!DOCTYPE html><html><body><script type="module" src="./assets/index.js"></script></body></html>',
      "assets/index.js": 'console.log("c");',
    },
    ...overrides,
  });
}

export type TestFetch = (input: string | Request, init?: RequestInit) => Promise<Response>;

export async function createTestOrchestrator(): Promise<{
  fetch: TestFetch;
  store: BundleStore;
  scopeKey: ScopeKey;
  kvStore: KvStore;
  vectorStore: ServerVectorStore;
}> {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const vectorStore = createTestVectorStore();
  const app = createOrchestrator({ slots: new Map(), store, scopeKey, kvStore, vectorStore });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, scopeKey, kvStore, vectorStore };
}

export async function deployAgent(
  fetch: TestFetch,
  slug = "my-agent",
  key = "key1",
): Promise<void> {
  await fetch(`/${slug}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: deployBody(),
  });
}

export function createTestKvStore(): KvStore {
  const store = new Map<string, string>();

  return {
    get(scope, key) {
      return Promise.resolve(store.get(scopedKey("kv", scope, key)) ?? null);
    },
    set(scope, key, value) {
      store.set(scopedKey("kv", scope, key), value);
      return Promise.resolve();
    },
    del(scope, key) {
      store.delete(scopedKey("kv", scope, key));
      return Promise.resolve();
    },
    keys(scope, pattern) {
      const results = [...entriesWithPrefix(store, "kv", scope)].map(([k]) => k);
      if (pattern) {
        const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
        return Promise.resolve(results.filter((k) => regex.test(k)));
      }
      return Promise.resolve(results);
    },
    list(scope, userPrefix, options) {
      const entries: { key: string; value: unknown }[] = [];
      for (const [key, value] of entriesWithPrefix(store, "kv", scope, userPrefix)) {
        try {
          entries.push({ key, value: JSON.parse(value) });
        } catch {
          entries.push({ key, value });
        }
      }
      return Promise.resolve(sortAndPaginate(entries, options));
    },
  };
}

export function createTestVectorStore(): ServerVectorStore {
  const store = new Map<string, { data: string; metadata?: Record<string, unknown> | undefined }>();

  return {
    upsert(scope, id, data, metadata) {
      store.set(scopedKey("vec", scope, id), { data, metadata });
      return Promise.resolve();
    },
    query(scope, text, topK = 10, _filter?) {
      const query = text.toLowerCase();
      const results: {
        id: string;
        score: number;
        data?: string | undefined;
        metadata?: Record<string, unknown> | undefined;
      }[] = [];

      for (const [id, entry] of entriesWithPrefix(store, "vec", scope)) {
        const data = entry.data.toLowerCase();
        const words = query.split(/\s+/).filter(Boolean);
        const matches = words.filter((w) => data.includes(w)).length;
        if (matches > 0) {
          results.push({
            id,
            score: matches / Math.max(words.length, 1),
            data: entry.data,
            metadata: entry.metadata,
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return Promise.resolve(results.slice(0, topK));
    },
    remove(scope, ids) {
      for (const id of ids) {
        store.delete(scopedKey("vec", scope, id));
      }
      return Promise.resolve();
    },
  };
}
