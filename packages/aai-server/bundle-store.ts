// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by unstorage (S3-compatible storage via Tigris, R2, etc.).

import { errorMessage } from "@alexkroman1/aai";
import { getLock } from "p-lock";
import type { Storage } from "unstorage";
import { z } from "zod";
import { retryOnTransient } from "./_retry.ts";
import { metrics, observeDurationWithStatus } from "./metrics.ts";
import { type IsolateConfig, IsolateConfigSchema } from "./rpc-schemas.ts";
import { type AgentMetadata, AgentMetadataSchema } from "./schemas.ts";
import { decryptEnv, encryptEnv, type MasterKey } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

export type { BundleStore } from "./store-types.ts";

const ManifestSchema = z.object({
  slug: z.string(),
  env: z.string(),
  credential_hashes: z.array(z.string()).optional(),
  envEncrypted: z.boolean().optional(),
});

// Decrypting + Zod-parsing the manifest takes ~15-20ms per call, and the
// same slug is read on every WebSocket upgrade, health check, KV request,
// and asset fetch. TTL bounds staleness for multi-replica deployments
// where another replica may have mutated the underlying storage.
const STORE_CACHE_TTL_MS = 60_000;

type CacheEntry<T> = { value: T; expires: number };

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

async function instrumentTigris<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return observeDurationWithStatus(
    metrics.upstreamCallSeconds,
    metrics.upstreamCall,
    { upstream: "tigris", op },
    fn,
  );
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return;
  if (entry.expires < Date.now()) {
    cache.delete(key);
    return;
  }
  return entry.value;
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expires: Date.now() + STORE_CACHE_TTL_MS });
}

// Return the cached value if fresh, otherwise load it. The loader resolves to
// the value to cache, or `undefined` to return `null` without caching (e.g.
// transient corruption shouldn't stick in the cache).
async function getOrLoad<T>(
  cache: Map<string, CacheEntry<T | null>>,
  key: string,
  load: () => Promise<T | null | undefined>,
): Promise<T | null> {
  const cached = cacheGet(cache, key);
  if (cached !== undefined) return cached;
  const loaded = await load();
  if (loaded === undefined) return null;
  cacheSet(cache, key, loaded);
  return loaded;
}

export function createBundleStore(storage: Storage, opts: { masterKey: MasterKey }): BundleStore {
  const { masterKey } = opts;

  const manifestLock = getLock();

  // `null` cache values mean "confirmed miss" — distinct from `undefined` (not cached).
  const manifestCache = new Map<string, CacheEntry<AgentMetadata | null>>();
  const configCache = new Map<string, CacheEntry<IsolateConfig | null>>();

  function invalidate(slug: string): void {
    manifestCache.delete(slug);
    configCache.delete(slug);
  }

  async function deleteByPrefix(prefix: string): Promise<void> {
    const keys = await storage.getKeys(prefix);
    await Promise.all(keys.map((k) => storage.removeItem(k)));
  }

  function readItem(key: string): Promise<string | null> {
    return retryOnTransient(async () => (await storage.getItem<string>(key)) ?? null, {
      onRetry: (attempt, attempts, err) => {
        console.warn(
          `Transient storage error reading ${key} (attempt ${attempt}/${attempts}): ${errorMessage(err)}`,
        );
      },
    });
  }

  // Some unstorage drivers auto-parse JSON keys; normalize back to a string before parsing.
  async function readJson(key: string): Promise<unknown | null> {
    const data = await readItem(key);
    if (data == null) return null;
    return JSON.parse(typeof data === "string" ? data : JSON.stringify(data));
  }

  async function getRawManifest(slug: string): Promise<z.infer<typeof ManifestSchema> | null> {
    const json = await readJson(objectKey(slug, "manifest.json"));
    return json == null ? null : ManifestSchema.parse(json);
  }

  async function loadManifest(slug: string): Promise<AgentMetadata | null> {
    const raw = await getRawManifest(slug);
    if (!raw) return null;
    const env = await decryptEnv(masterKey, { encrypted: raw.env, slug });
    const parsed = AgentMetadataSchema.safeParse({ ...raw, env, envEncrypted: undefined });
    return parsed.success ? parsed.data : null;
  }

  function getManifestCached(slug: string): Promise<AgentMetadata | null> {
    return getOrLoad(manifestCache, slug, () => loadManifest(slug));
  }

  return {
    putAgent(bundle) {
      return instrumentTigris("putAgent", async () => {
        invalidate(bundle.slug);
        try {
          await deleteByPrefix(`agents/${bundle.slug}`);
        } catch (err) {
          console.warn(
            `Failed to delete old agent files for ${bundle.slug}, proceeding with overwrite: ${errorMessage(err)}`,
          );
        }

        const manifest = {
          slug: bundle.slug,
          env: await encryptEnv(masterKey, { env: bundle.env, slug: bundle.slug }),
          credential_hashes: bundle.credential_hashes,
          envEncrypted: true,
        };
        await Promise.all([
          storage.setItem(objectKey(bundle.slug, "manifest.json"), JSON.stringify(manifest)),
          storage.setItem(objectKey(bundle.slug, "worker.js"), bundle.worker),
          ...Object.entries(bundle.clientFiles).map(([filePath, content]) =>
            storage.setItem(objectKey(bundle.slug, `client/${filePath}`), content),
          ),
          storage.setItem(
            objectKey(bundle.slug, "config.json"),
            JSON.stringify(bundle.agentConfig),
          ),
        ]);
        // Re-invalidate to catch any concurrent read that repopulated the
        // cache with a pre-write value during the write window.
        invalidate(bundle.slug);
      });
    },

    getManifest(slug) {
      return instrumentTigris("getManifest", () => getManifestCached(slug));
    },

    getWorkerCode(slug) {
      return instrumentTigris("getWorkerCode", () => readItem(objectKey(slug, "worker.js")));
    },

    getClientFile(slug, filePath) {
      return instrumentTigris("getClientFile", () =>
        readItem(objectKey(slug, `client/${filePath}`)),
      );
    },

    deleteAgent(slug) {
      return instrumentTigris("deleteAgent", async () => {
        invalidate(slug);
        await deleteByPrefix(`agents/${slug}`);
        invalidate(slug);
      });
    },

    getEnv(slug) {
      return instrumentTigris("getEnv", async () => (await getManifestCached(slug))?.env ?? null);
    },

    putEnv(slug, env) {
      return instrumentTigris("putEnv", async () => {
        const release = await manifestLock(slug);
        try {
          const raw = await getRawManifest(slug);
          if (!raw) throw new Error(`Agent ${slug} not found`);
          const updated = {
            ...raw,
            env: await encryptEnv(masterKey, { env, slug }),
            envEncrypted: true,
          };
          await storage.setItem(objectKey(slug, "manifest.json"), JSON.stringify(updated));
          manifestCache.delete(slug);
        } finally {
          release();
        }
      });
    },

    getAgentConfig(slug) {
      return instrumentTigris("getAgentConfig", () =>
        getOrLoad(configCache, slug, async () => {
          const json = await readJson(objectKey(slug, "config.json"));
          if (json == null) return null;
          // `undefined` returns null without caching — transient corruption
          // shouldn't stick.
          const parsed = IsolateConfigSchema.safeParse(json);
          return parsed.success ? parsed.data : undefined;
        }),
      );
    },
  };
}
