// Copyright 2025 the AAI authors. MIT license.
// Bundle store backed by unstorage (S3-compatible storage — Supabase Storage
// in production) plus a SecretStore for agent env records.
//
// Env storage is a clean break from the old design: the manifest used to
// carry the env as a master-key-encrypted blob (iron / AES-GCM envelopes).
// Env records now live in the injected SecretStore (Supabase Vault in
// production) under `agent-env:<slug>`, JSON-serialized, and the manifest
// keeps only slug + credential_hashes. There is deliberately NO legacy
// decrypt path — this migration supersedes the old "never delete a legacy
// read path" rule for env blobs.

import { errorMessage } from "@alexkroman1/aai";
import type { Storage } from "unstorage";
import { z } from "zod";
import { createKeyedLock } from "./_keyed-lock.ts";
import { retryOnTransient } from "./_retry.ts";
import { TtlCache } from "./_ttl-cache.ts";
import { agentObjectKey, agentPrefix, MAX_ENV_SIZE } from "./constants.ts";
import { type IsolateConfig, IsolateConfigSchema } from "./rpc-schemas.ts";
import { withLock } from "./sandbox-slots.ts";
import { type AgentMetadata, AgentMetadataSchema, EnvSchema } from "./schemas.ts";
import { agentEnvSecretName, appDbSecretName, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

export type { BundleStore } from "./store-types.ts";

const ManifestSchema = z.object({
  slug: z.string(),
  credential_hashes: z.array(z.string()).optional(),
});

// Fetching the env record + Zod-parsing the manifest costs a round trip per
// call, and the same slug is read on every WebSocket upgrade, health check,
// and asset fetch. TTL bounds staleness for multi-replica deployments
// where another replica may have mutated the underlying storage.
const STORE_CACHE_TTL_MS = 60_000;

// Client page/asset bytes are immutable per deploy (served with
// `Cache-Control: immutable`), so cache them like the manifest. LRU-capped
// since individual assets can be large.
const CLIENT_FILE_CACHE_MAX = 64;

// Worker bundles are immutable per deploy, and every deploy/delete calls
// invalidate() — so on this replica a long TTL is safe. The TTL exists only
// to bound cross-replica staleness (a deploy landing on another replica
// invalidates *its* cache, not ours); 10 minutes keeps that window short
// while sparing hosts the up-to-10 MB S3 refetch on every cold start.
const WORKER_CODE_CACHE_TTL_MS = 10 * 60 * 1000;
// Bundles range from KBs to MAX_WORKER_SIZE (10 MB), so an entry-count cap
// is either too tight for many small agents or too loose for a few large
// ones — budget by total bytes instead and evict LRU until under budget.
const WORKER_CODE_CACHE_MAX_BYTES = 128 * 1024 * 1024;

// Charged per entry on top of the value size: bounds the entry count for
// tiny and confirmed-miss (null) entries, which would otherwise be "free"
// under a pure byte budget and accumulate one Map slot per probed slug.
const BYTE_CACHE_ENTRY_OVERHEAD = 4096;

type ByteCacheEntry<V> = { value: V; bytes: number; expiresAt: number };

/**
 * Byte-budgeted expire-on-read LRU cache. Unlike `TtlCache` (entry-counted),
 * eviction is driven by total value bytes, so the same budget serves many
 * small bundles or a few large ones. Exported for direct testing.
 */
export class ByteBudgetTtlCache<V> {
  readonly #entries = new Map<string, ByteCacheEntry<V>>();
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  #totalBytes = 0;

  constructor(ttlMs: number, maxBytes: number) {
    this.#ttlMs = ttlMs;
    this.#maxBytes = maxBytes;
  }

  /** Total bytes currently charged against the budget (incl. per-entry overhead). */
  get totalBytes(): number {
    return this.#totalBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (Date.now() >= entry.expiresAt) {
      this.delete(key);
      return;
    }
    // Refresh recency — Map iteration order is insertion order, so the
    // oldest key is always first when evicting.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** `valueBytes` is the value's size; string `length` is a fine approximation. */
  set(key: string, value: V, valueBytes: number): void {
    this.delete(key);
    const bytes = valueBytes + BYTE_CACHE_ENTRY_OVERHEAD;
    // A value larger than the whole budget can never fit — don't evict
    // everything else only to fail anyway.
    if (bytes > this.#maxBytes) return;
    this.#entries.set(key, { value, bytes, expiresAt: Date.now() + this.#ttlMs });
    this.#totalBytes += bytes;
    for (const oldest of this.#entries.keys()) {
      if (this.#totalBytes <= this.#maxBytes || oldest === key) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#totalBytes -= entry.bytes;
  }
}

export function createBundleStore(storage: Storage, opts: { secrets: SecretStore }): BundleStore {
  const { secrets } = opts;

  const manifestLock = createKeyedLock();

  // `null` cache values mean "confirmed miss" — distinct from `undefined` (not cached).
  const manifestCache = new TtlCache<AgentMetadata | null>(STORE_CACHE_TTL_MS);
  const configCache = new TtlCache<IsolateConfig | null>(STORE_CACHE_TTL_MS);
  // Keyed by full object key (`agents/<slug>/client/<path>`).
  const clientFileCache = new TtlCache<string | null>(STORE_CACHE_TTL_MS, CLIENT_FILE_CACHE_MAX);
  const workerCodeCache = new ByteBudgetTtlCache<string | null>(
    WORKER_CODE_CACHE_TTL_MS,
    WORKER_CODE_CACHE_MAX_BYTES,
  );

  function invalidate(slug: string): void {
    manifestCache.delete(slug);
    configCache.delete(slug);
    workerCodeCache.delete(slug);
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

  // Some unstorage drivers auto-parse JSON keys; return the parsed value
  // directly instead of a stringify→parse round trip. Callers Zod-validate
  // the shape either way, so both paths are checked identically.
  async function readJson(key: string): Promise<unknown | null> {
    const data = await readItem(key);
    if (data == null) return null;
    if (typeof data !== "string") return data; // driver already parsed it
    try {
      return JSON.parse(data);
    } catch {
      // Corrupt stored object — treat as missing rather than throwing on
      // every read of this key (matches getAgentConfig's safeParse posture).
      console.warn(`Corrupt JSON in stored object ${key}; treating as missing`);
      return null;
    }
  }

  async function getRawManifest(slug: string): Promise<z.infer<typeof ManifestSchema> | null> {
    const json = await readJson(agentObjectKey(slug, "manifest.json"));
    if (json == null) return null;
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success) {
      console.warn(`Corrupt manifest for agent ${slug}; treating as missing`);
      return null;
    }
    return parsed.data;
  }

  /**
   * Read + parse the agent's env record from the SecretStore. A corrupt
   * record throws rather than degrading to `{}` — a secretless boot runs the
   * agent with its tenant credentials silently absent, which is strictly
   * worse than a failed boot.
   */
  async function loadEnv(slug: string): Promise<Record<string, string>> {
    const raw = await secrets.get(agentEnvSecretName(slug));
    if (raw === null) return {};
    try {
      return EnvSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new Error(`Corrupt env record for agent ${slug}`, { cause: err });
    }
  }

  async function loadManifest(slug: string): Promise<AgentMetadata | null> {
    // Independent reads (S3 manifest, Vault env) — fetch both concurrently;
    // the env result is irrelevant when the manifest is missing.
    const [raw, env] = await Promise.all([getRawManifest(slug), loadEnv(slug)]);
    if (!raw) return null;
    const parsed = AgentMetadataSchema.safeParse({ ...raw, env });
    return parsed.success ? parsed.data : null;
  }

  /** Serialize + size-check + write one agent's env record to the SecretStore. */
  async function writeEnv(slug: string, env: Record<string, string>): Promise<void> {
    const serialized = JSON.stringify(env);
    if (serialized.length > MAX_ENV_SIZE) {
      throw new Error(
        `Agent env for ${slug} exceeds the ${MAX_ENV_SIZE}-byte limit (${serialized.length} bytes)`,
      );
    }
    await secrets.put(agentEnvSecretName(slug), serialized);
  }

  async function getManifestCached(slug: string): Promise<AgentMetadata | null> {
    const cached = manifestCache.get(slug);
    if (cached !== undefined) return cached;
    const value = await loadManifest(slug);
    manifestCache.set(slug, value);
    return value;
  }

  return {
    async putAgent(bundle) {
      invalidate(bundle.slug);
      try {
        await deleteByPrefix(agentPrefix(bundle.slug));
      } catch (err) {
        console.warn(
          `Failed to delete old agent files for ${bundle.slug}, proceeding with overwrite: ${errorMessage(err)}`,
        );
      }

      const manifest = {
        slug: bundle.slug,
        credential_hashes: bundle.credential_hashes,
      };
      // All writes go to distinct keys with no ordering requirement
      // (deleteByPrefix already cleared the prefix; the trailing
      // invalidate handles cache races), so run them concurrently.
      await Promise.all([
        writeEnv(bundle.slug, bundle.env),
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
    },

    getManifest(slug) {
      return getManifestCached(slug);
    },

    async getWorkerCode(slug) {
      const cached = workerCodeCache.get(slug);
      if (cached !== undefined) return cached;
      const value = await readItem(agentObjectKey(slug, "worker.js"));
      workerCodeCache.set(slug, value, value?.length ?? 0);
      return value;
    },

    async getClientFile(slug, filePath) {
      const key = agentObjectKey(slug, `client/${filePath}`);
      const cached = clientFileCache.get(key);
      if (cached !== undefined) return cached;
      const value = await readItem(key);
      clientFileCache.set(key, value);
      return value;
    },

    async deleteAgent(slug) {
      invalidate(slug);
      await Promise.all([
        deleteByPrefix(agentPrefix(slug)),
        // Delete-only sweep of this agent's SecretStore entries. The
        // app-db credentials go too; the caller (delete route) is
        // responsible for deprovisioning the database itself first.
        secrets.delete(agentEnvSecretName(slug)),
        secrets.delete(appDbSecretName(slug)),
      ]);
      invalidate(slug);
    },

    async getEnv(slug) {
      return (await getManifestCached(slug))?.env ?? null;
    },

    putEnv(slug, env) {
      return withLock(manifestLock, slug, async () => {
        // The manifest existence check keeps putEnv's contract: env for an
        // unknown agent is an error, not a silent secret write.
        const manifest = await getManifestCached(slug);
        if (!manifest) throw new Error(`Agent ${slug} not found`);
        await writeEnv(slug, env);
        manifestCache.delete(slug);
      });
    },

    async getAgentConfig(slug) {
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
    },
  };
}
