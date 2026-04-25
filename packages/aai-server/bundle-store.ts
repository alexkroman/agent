// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by unstorage (S3-compatible storage via Tigris, R2, etc.).

import { errorMessage } from "@alexkroman1/aai";
import { getLock } from "p-lock";
import type { Storage } from "unstorage";
import { z } from "zod";
import { retryOnTransient } from "./_retry.ts";
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

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

// Decrypting + Zod-parsing the manifest takes ~15-20ms per call, and the
// same slug is read on every WebSocket upgrade, health check, KV request,
// and asset fetch. Cache both the parsed manifest (with decrypted env) and
// the parsed agent config per slug, invalidated on writes. TTL bounds
// staleness for multi-replica deployments where another replica may have
// mutated the underlying storage.
const STORE_CACHE_TTL_MS = 60_000;

type CacheEntry<T> = { value: T; expires: number };

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

export function createBundleStore(storage: Storage, opts: { masterKey: MasterKey }): BundleStore {
  const { masterKey } = opts;

  const manifestLock = getLock();

  // Per-slug cache of fully parsed AgentMetadata (env already decrypted).
  // `null` means "cached miss" (no manifest exists).
  const manifestCache = new Map<string, CacheEntry<AgentMetadata | null>>();
  // Per-slug cache of parsed IsolateConfig. `null` means "cached miss".
  const configCache = new Map<string, CacheEntry<IsolateConfig | null>>();

  function invalidate(slug: string): void {
    manifestCache.delete(slug);
    configCache.delete(slug);
  }

  async function deleteByPrefix(prefix: string): Promise<void> {
    const keys = await storage.getKeys(prefix);
    await Promise.all(keys.map((k) => storage.removeItem(k)));
  }

  /**
   * Reads from the underlying storage with bounded retries on transient
   * network errors (ECONNRESET etc.). Non-transient failures propagate
   * unchanged on the first attempt.
   */
  function readItem(key: string): Promise<string | null> {
    return retryOnTransient(async () => (await storage.getItem<string>(key)) ?? null, {
      onRetry: (attempt, attempts, err) => {
        console.warn(
          `Transient storage error reading ${key} (attempt ${attempt}/${attempts}): ${errorMessage(err)}`,
        );
      },
    });
  }

  async function getRawManifest(slug: string): Promise<z.infer<typeof ManifestSchema> | null> {
    const data = await readItem(objectKey(slug, "manifest.json"));
    if (data == null) return null;
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    return ManifestSchema.parse(JSON.parse(raw));
  }

  async function loadManifest(slug: string): Promise<AgentMetadata | null> {
    const raw = await getRawManifest(slug);
    if (!raw) return null;
    const env = await decryptEnv(masterKey, { encrypted: raw.env, slug });
    const parsed = AgentMetadataSchema.safeParse({
      ...raw,
      env,
      envEncrypted: undefined,
    });
    return parsed.success ? parsed.data : null;
  }

  const store: BundleStore = {
    async putAgent(bundle) {
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
      await storage.setItem(objectKey(bundle.slug, "manifest.json"), JSON.stringify(manifest));
      await storage.setItem(objectKey(bundle.slug, "worker.js"), bundle.worker);

      await Promise.all([
        ...Object.entries(bundle.clientFiles).map(([filePath, content]) =>
          storage.setItem(objectKey(bundle.slug, `client/${filePath}`), content),
        ),
        storage.setItem(objectKey(bundle.slug, "config.json"), JSON.stringify(bundle.agentConfig)),
      ]);
      // Re-invalidate to catch any concurrent read that repopulated the
      // cache with a pre-write value during the write window.
      invalidate(bundle.slug);
    },

    async getManifest(slug) {
      const cached = cacheGet(manifestCache, slug);
      if (cached !== undefined) return cached;
      const value = await loadManifest(slug);
      cacheSet(manifestCache, slug, value);
      return value;
    },

    async getWorkerCode(slug) {
      return readItem(objectKey(slug, "worker.js"));
    },

    async getClientFile(slug, filePath) {
      return readItem(objectKey(slug, `client/${filePath}`));
    },

    async deleteAgent(slug) {
      invalidate(slug);
      await deleteByPrefix(`agents/${slug}`);
      invalidate(slug);
    },

    async getEnv(slug) {
      const cached = cacheGet(manifestCache, slug);
      if (cached !== undefined) return cached?.env ?? null;
      const manifest = await loadManifest(slug);
      cacheSet(manifestCache, slug, manifest);
      return manifest?.env ?? null;
    },

    async putEnv(slug, env) {
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
    },

    async getAgentConfig(slug) {
      const cached = cacheGet(configCache, slug);
      if (cached !== undefined) return cached;
      const data = await readItem(objectKey(slug, "config.json"));
      if (data == null) {
        cacheSet(configCache, slug, null);
        return null;
      }
      try {
        const raw = typeof data === "string" ? data : JSON.stringify(data);
        const parsed = IsolateConfigSchema.parse(JSON.parse(raw));
        cacheSet(configCache, slug, parsed);
        return parsed;
      } catch {
        // Don't cache parse failures — transient corruption shouldn't stick.
        return null;
      }
    },
  };

  return store;
}
