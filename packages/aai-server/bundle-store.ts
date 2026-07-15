// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by unstorage (S3-compatible storage via Tigris, R2, etc.).

import { errorMessage } from "@alexkroman1/aai";
import { getLock } from "p-lock";
import type { Storage } from "unstorage";
import { z } from "zod";
import { retryOnTransient } from "./_retry.ts";
import { TtlCache } from "./_ttl-cache.ts";
import { agentObjectKey, agentPrefix } from "./constants.ts";
import { metrics, observeDurationWithStatus } from "./metrics.ts";
import { type IsolateConfig, IsolateConfigSchema } from "./rpc-schemas.ts";
import { withLock } from "./sandbox-slots.ts";
import { type AgentMetadata, AgentMetadataSchema } from "./schemas.ts";
import { decryptEnv, encryptEnv, type MasterKey } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

export type { BundleStore } from "./store-types.ts";

const ManifestSchema = z.object({
  slug: z.string(),
  env: z.string(),
  credential_hashes: z.array(z.string()).optional(),
});

// Decrypting + Zod-parsing the manifest takes ~15-20ms per call, and the
// same slug is read on every WebSocket upgrade, health check, KV request,
// and asset fetch. TTL bounds staleness for multi-replica deployments
// where another replica may have mutated the underlying storage.
const STORE_CACHE_TTL_MS = 60_000;

// Client page/asset bytes are immutable per deploy (served with
// `Cache-Control: immutable`), so cache them like the manifest. LRU-capped
// since individual assets can be large.
const CLIENT_FILE_CACHE_MAX = 64;

async function instrumentTigris<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return observeDurationWithStatus(
    metrics.upstreamCallSeconds,
    metrics.upstreamCall,
    { upstream: "tigris", op },
    fn,
  );
}

export function createBundleStore(storage: Storage, opts: { masterKey: MasterKey }): BundleStore {
  const { masterKey } = opts;

  const manifestLock = getLock();

  // `null` cache values mean "confirmed miss" — distinct from `undefined` (not cached).
  const manifestCache = new TtlCache<AgentMetadata | null>(STORE_CACHE_TTL_MS);
  const configCache = new TtlCache<IsolateConfig | null>(STORE_CACHE_TTL_MS);
  // Keyed by full object key (`agents/<slug>/client/<path>`).
  const clientFileCache = new TtlCache<string | null>(STORE_CACHE_TTL_MS, CLIENT_FILE_CACHE_MAX);

  function invalidate(slug: string): void {
    manifestCache.delete(slug);
    configCache.delete(slug);
    clientFileCache.deletePrefix(`${agentPrefix(slug)}/`);
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
    const json = await readJson(agentObjectKey(slug, "manifest.json"));
    return json == null ? null : ManifestSchema.parse(json);
  }

  async function loadManifest(slug: string): Promise<AgentMetadata | null> {
    const raw = await getRawManifest(slug);
    if (!raw) return null;
    const env = await decryptEnv(masterKey, { encrypted: raw.env, slug });
    const parsed = AgentMetadataSchema.safeParse({ ...raw, env });
    return parsed.success ? parsed.data : null;
  }

  async function getManifestCached(slug: string): Promise<AgentMetadata | null> {
    const cached = manifestCache.get(slug);
    if (cached !== undefined) return cached;
    const value = await loadManifest(slug);
    manifestCache.set(slug, value);
    return value;
  }

  return {
    putAgent(bundle) {
      return instrumentTigris("putAgent", async () => {
        invalidate(bundle.slug);
        try {
          // Note: this sweep covers the whole agent prefix, including the
          // agent's platform-default KV data (see constants.ts).
          await deleteByPrefix(agentPrefix(bundle.slug));
        } catch (err) {
          console.warn(
            `Failed to delete old agent files for ${bundle.slug}, proceeding with overwrite: ${errorMessage(err)}`,
          );
        }

        const manifest = {
          slug: bundle.slug,
          env: await encryptEnv(masterKey, { env: bundle.env, slug: bundle.slug }),
          credential_hashes: bundle.credential_hashes,
        };
        // All writes go to distinct keys with no ordering requirement
        // (deleteByPrefix already cleared the prefix; the trailing
        // invalidate handles cache races), so run them concurrently.
        await Promise.all([
          storage.setItem(agentObjectKey(bundle.slug, "manifest.json"), JSON.stringify(manifest)),
          storage.setItem(agentObjectKey(bundle.slug, "worker.js"), bundle.worker),
          ...Object.entries(bundle.clientFiles).map(([filePath, content]) =>
            storage.setItem(agentObjectKey(bundle.slug, `client/${filePath}`), content),
          ),
          storage.setItem(
            agentObjectKey(bundle.slug, "config.json"),
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
      return instrumentTigris("getWorkerCode", () => readItem(agentObjectKey(slug, "worker.js")));
    },

    getClientFile(slug, filePath) {
      return instrumentTigris("getClientFile", async () => {
        const key = agentObjectKey(slug, `client/${filePath}`);
        const cached = clientFileCache.get(key);
        if (cached !== undefined) return cached;
        const value = await readItem(key);
        clientFileCache.set(key, value);
        return value;
      });
    },

    deleteAgent(slug) {
      return instrumentTigris("deleteAgent", async () => {
        invalidate(slug);
        await deleteByPrefix(agentPrefix(slug));
        invalidate(slug);
      });
    },

    getEnv(slug) {
      return instrumentTigris("getEnv", async () => (await getManifestCached(slug))?.env ?? null);
    },

    putEnv(slug, env) {
      return instrumentTigris("putEnv", () =>
        withLock(manifestLock, slug, async () => {
          const raw = await getRawManifest(slug);
          if (!raw) throw new Error(`Agent ${slug} not found`);
          const updated = {
            ...raw,
            env: await encryptEnv(masterKey, { env, slug }),
          };
          await storage.setItem(agentObjectKey(slug, "manifest.json"), JSON.stringify(updated));
          manifestCache.delete(slug);
        }),
      );
    },

    getAgentConfig(slug) {
      return instrumentTigris("getAgentConfig", async () => {
        const cached = configCache.get(slug);
        if (cached !== undefined) return cached;
        const json = await readJson(agentObjectKey(slug, "config.json"));
        if (json == null) {
          configCache.set(slug, null);
          return null;
        }
        // Don't cache parse failures — transient corruption shouldn't stick.
        const parsed = IsolateConfigSchema.safeParse(json);
        if (!parsed.success) return null;
        configCache.set(slug, parsed.data);
        return parsed.data;
      });
    },
  };
}
