// Copyright 2025 the AAI authors. MIT license.
/**
 * Local dev mode backends: SQLite KV, filesystem BundleStore, no vector.
 * Used when AAI_LOCAL_DEV=1 to avoid requiring Upstash/Tigris credentials.
 */

import { mkdirSync } from "node:fs";
import type { Kv } from "@alexkroman1/aai/kv";
import { MAX_VALUE_SIZE, matchGlob } from "@alexkroman1/aai/kv";
import { createSqliteKv } from "@alexkroman1/aai/sqlite-kv";
import { createSqliteVecVectorStore } from "@alexkroman1/aai/sqlite-vec-vector";
import type { VectorEntry } from "@alexkroman1/aai/vector";
import { type AgentMetadata, AgentMetadataSchema } from "./_schemas.ts";
import type { BundleStore } from "./bundle-store-tigris.ts";
import type { KvStore } from "./kv.ts";
import type { AgentScope } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

const DATA_DIR = ".aai/server-data";

function scopedKey(scope: AgentScope, key: string): string {
  return `kv:${scope.keyHash}:${scope.slug}:${key}`;
}

function scopePrefix(scope: AgentScope): string {
  return `kv:${scope.keyHash}:${scope.slug}:`;
}

/** Wrap the SDK's Kv interface into the platform KvStore (scoped) interface. */
export function createLocalKvStore(): KvStore {
  mkdirSync(DATA_DIR, { recursive: true });
  const kv: Kv = createSqliteKv({ path: `${DATA_DIR}/kv.db` });

  return {
    async get(scope, key) {
      const val = await kv.get<string>(scopedKey(scope, key));
      return val ?? null;
    },
    async set(scope, key, value, expireIn) {
      if (value.length > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      await kv.set(scopedKey(scope, key), value, expireIn ? { expireIn } : undefined);
    },
    async del(scope, key) {
      await kv.delete(scopedKey(scope, key));
    },
    async keys(scope, pattern) {
      const prefix = scopePrefix(scope);
      const allKeys = await kv.keys(`${prefix}*`);
      const stripped = allKeys.map((k) => k.slice(prefix.length));
      if (!pattern) return stripped;
      return stripped.filter((k) => matchGlob(k, pattern));
    },
    async list(scope, userPrefix, options) {
      const prefix = scopePrefix(scope);
      const entries = await kv.list<unknown>(`${prefix}${userPrefix}`, options);
      return entries.map((e) => ({ key: e.key.slice(prefix.length), value: e.value }));
    },
  };
}

/** In-memory BundleStore backed by a Map (same as test utils). */
export function createLocalBundleStore(): BundleStore {
  const objects = new Map<string, string>();

  function objectKey(slug: string, path: string): string {
    return `agents/${slug}/${path}`;
  }

  function deleteByPrefix(prefix: string): void {
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

function vectorScope(scope: AgentScope): string {
  return `${scope.keyHash}:${scope.slug}`;
}

/** Wrap the SDK's SQLite-vec VectorStore into a scoped ServerVectorStore. */
export function createLocalVectorStore(): ServerVectorStore {
  mkdirSync(DATA_DIR, { recursive: true });
  const store = createSqliteVecVectorStore({ path: `${DATA_DIR}/vectors.db` });
  return {
    async upsert(scope, id, data, metadata) {
      const scopedId = `${vectorScope(scope)}:${id}`;
      await store.upsert(scopedId, data, { ...metadata, _scope: vectorScope(scope) });
    },
    async query(scope, text, topK, _filter) {
      const prefix = `${vectorScope(scope)}:`;
      const results = await store.query(text, { topK: topK ?? 10 });
      // Filter to only this scope's results and strip scope prefix from IDs
      return results
        .filter((r: VectorEntry) => r.id.startsWith(prefix))
        .map((r: VectorEntry) => ({
          ...r,
          id: r.id.slice(prefix.length),
        }));
    },
    async remove(_scope, _ids) {
      // no-op for local dev
    },
  };
}
