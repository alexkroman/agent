// Copyright 2025 the AAI authors. MIT license.

import type { Kv } from "@alexkroman1/aai/kv";
import { createStorage, type Storage } from "unstorage";
import { vi } from "vitest";
import { type AgentMetadata, AgentMetadataSchema } from "./_schemas.ts";
import type { BundleStore } from "./bundle-store.ts";
import { createOrchestrator } from "./orchestrator.ts";
import type { AgentSlot } from "./sandbox.ts";

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
    keys: vi.fn(async () => [] as string[]),
    list: vi.fn(async () => []) as Kv["list"],
  };
}

export const VALID_ENV = {
  ASSEMBLYAI_API_KEY: "test-key",
};

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
  storage: Storage;
}> {
  const store = createTestStore();
  const storage = createTestStorage();
  const { app } = createOrchestrator({ slots: new Map(), store, storage });
  const fetch: TestFetch = async (input, init) => app.request(input, init);
  return { fetch, store, storage };
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
