// Copyright 2025 the AAI authors. MIT license.
// Bundle store: agents rows (Postgres in production — see agent-store.ts)
// pointing at content-addressed blobs in unstorage (S3-compatible storage —
// Supabase Storage in production), plus a SecretStore for agent env records.
//
// Layout per deploy:
// - `blobs/<sha256>` — the worker bundle and each client file, IMMUTABLE by
//   construction (the key is the content hash). A deploy writes its blobs
//   first, then commits the agents row referencing them, so a crash
//   mid-deploy never publishes a half-written agent and in-flight readers
//   of the previous deploy keep resolving its blobs. Deleted/superseded
//   deploys leave orphan blobs behind — accepted (identical content dedupes
//   across deploys, and a shared blob must not die with one referrer).
// - agents row — slug, credential_hashes, config, blob hashes, version
//   (see agent-store.ts). The row is the only mutable state.
// - env — the injected SecretStore (Supabase Vault in production) under
//   `agent-env:<slug>`, JSON-serialized. Read fresh on every getEnv: a
//   secret change takes effect on the next sandbox build (a redeploy forces
//   one), never by proactive invalidation.

import { hash } from "node:crypto";
import { errorMessage } from "@alexkroman1/aai";
import { createEpoch } from "@alexkroman1/aai/internal";
import { LRUCache } from "lru-cache";
import type { Storage } from "unstorage";
import { createKeyedLock, withLock } from "./_keyed-lock.ts";
import { retryOnTransient } from "./_retry.ts";
import { TtlCache } from "./_ttl-cache.ts";
import type { AgentRecord, AgentRows } from "./agent-store.ts";
import { MAX_ENV_SIZE } from "./constants.ts";
import { EnvSchema } from "./schemas.ts";
import { agentEnvSecretName, appDbSecretName, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

export type { BundleStore } from "./store-types.ts";

/** Storage key for a content-addressed blob. */
export function blobKey(contentHash: string): string {
  return `blobs/${contentHash}`;
}

/** sha-256 hex of a blob's content — the identity blobs are stored under. */
export function contentHash(content: string): string {
  return hash("sha256", content);
}

// The agents row is read on every WebSocket upgrade, broker call, and asset
// fetch; a short TTL keeps that off the shared Postgres pool without giving
// another replica's deploy a long invisibility window. A stale row is always
// a CONSISTENT older deploy (its blob hashes still resolve — blobs are
// immutable), never a torn mix.
const ROW_CACHE_TTL_MS = 15_000;

// The version read backs the change-event handler's superseded comparison
// (watchAgentInvalidation, which invalidates before reading) and the peer
// route's existence gate, so it tolerates far less staleness than the row —
// 1s only keeps a burst of reads for one slug from stampeding the shared
// admin pool.
const VERSION_CACHE_TTL_MS = 1000;

// Blob content is immutable per key, so the TTL exists only to let unused
// entries age out; eviction is the byte budget's job.
const BLOB_CACHE_TTL_MS = 60 * 60 * 1000;
// Bundles range from KBs to MAX_WORKER_SIZE (30 MB), so an entry-count cap
// is either too tight for many small agents or too loose for a few large
// ones — budget by total bytes instead and evict LRU until under budget.
const BLOB_CACHE_MAX_BYTES = 128 * 1024 * 1024;

// Charged per entry on top of the value size: bounds the entry count for
// tiny entries, which would otherwise be "free" under a pure byte budget
// and accumulate one Map slot per probed hash.
const BYTE_CACHE_ENTRY_OVERHEAD = 4096;

/**
 * Cached value for a confirmed-missing blob — lru-cache cannot store `null`
 * (or `undefined`) directly, so misses are cached under this sentinel.
 */
export const BLOB_MISS = Symbol("blob-miss");

/**
 * Byte-budgeted LRU cache for blob content. Unlike `TtlCache`
 * (entry-counted), eviction is driven by total value bytes (`maxSize` +
 * `sizeCalculation`), so the same budget serves many small bundles or a few
 * large ones; a value larger than the whole budget is simply not cached.
 * Exported for direct testing — production passes the constants above.
 */
export function createBlobCache(
  ttlMs: number,
  maxBytes: number,
): LRUCache<string, string | typeof BLOB_MISS> {
  return new LRUCache({
    ttl: ttlMs,
    maxSize: maxBytes,
    // The value's own size (string `length` is a fine approximation) plus a
    // per-entry overhead, which bounds the entry count for tiny entries —
    // otherwise "free" under a pure byte budget, accumulating one map slot
    // per probed hash — and gives miss sentinels their required nonzero size.
    sizeCalculation: (value) =>
      (typeof value === "string" ? value.length : 0) + BYTE_CACHE_ENTRY_OVERHEAD,
  });
}

export function createBundleStore(
  storage: Storage,
  opts: { secrets: SecretStore; agents: AgentRows },
): BundleStore {
  const { secrets, agents } = opts;

  const envLock = createKeyedLock();

  // `null` cache values mean "confirmed miss" — distinct from `undefined` (not cached).
  const rowCache = new TtlCache<AgentRecord | null>(ROW_CACHE_TTL_MS);
  const versionCache = new TtlCache<number | null>(VERSION_CACHE_TTL_MS);
  const blobCache = createBlobCache(BLOB_CACHE_TTL_MS, BLOB_CACHE_MAX_BYTES);

  /**
   * Staleness guard for row reads already in flight when a mutation lands.
   * Clearing the caches does not fence them: a read that missed before the
   * write and settles after it would otherwise write its PRE-mutation row
   * straight back into the cache under a fresh TTL. That matters most for
   * the deploy's own read-modify-write of `credential_hashes`, which runs
   * right after the mutation lock's invalidate (see platform-lock.ts) — a
   * poisoned entry there silently drops a co-owner's hash. Blobs need no
   * guard: content-addressed keys cannot go stale.
   */
  const readEpoch = createEpoch();

  function invalidate(slug: string): void {
    readEpoch.bump();
    rowCache.delete(slug);
    versionCache.delete(slug);
  }

  function readBlob(contentHashHex: string): Promise<string | null> {
    const key = blobKey(contentHashHex);
    return retryOnTransient(async () => (await storage.getItem<string>(key)) ?? null, {
      onRetry: (attempt, attempts, err) => {
        console.warn(
          `Transient storage error reading ${key} (attempt ${attempt}/${attempts}): ${errorMessage(err)}`,
        );
      },
    });
  }

  async function readBlobCached(contentHashHex: string): Promise<string | null> {
    const cached = blobCache.get(contentHashHex);
    if (cached !== undefined) return cached === BLOB_MISS ? null : cached;
    const value = await readBlob(contentHashHex);
    // Cache misses too (BLOB_MISS): a hash referenced by a row either exists
    // or the deploy that wrote the row failed mid-blob-write — both stable.
    blobCache.set(contentHashHex, value ?? BLOB_MISS);
    return value;
  }

  async function getAgentCached(slug: string): Promise<AgentRecord | null> {
    const cached = rowCache.get(slug);
    if (cached !== undefined) return cached;
    const gen = readEpoch.current();
    const value = await agents.get(slug);
    if (readEpoch.isCurrent(gen)) rowCache.set(slug, value);
    return value;
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

  return {
    async putAgent(bundle) {
      const workerHash = contentHash(bundle.worker);
      const clientFiles = Object.fromEntries(
        Object.entries(bundle.clientFiles).map(([path, content]) => [path, contentHash(content)]),
      );

      // Blobs and env first, in parallel — all immutable or idempotent
      // writes to keys nothing references yet. Only after every one has
      // landed does the row upsert publish the deploy.
      await Promise.all([
        writeEnv(bundle.slug, bundle.env),
        storage.setItem(blobKey(workerHash), bundle.worker),
        ...Object.entries(bundle.clientFiles).map(([path, content]) =>
          storage.setItem(blobKey(clientFiles[path] ?? ""), content),
        ),
      ]);

      await agents.put({
        slug: bundle.slug,
        credential_hashes: bundle.credential_hashes,
        config: bundle.agentConfig,
        worker_hash: workerHash,
        client_files: clientFiles,
        harness_image_tag: bundle.harnessImageTag ?? null,
      });

      // Drop this replica's row caches so the next read sees the new deploy
      // immediately (peers converge via their version checks).
      invalidate(bundle.slug);
    },

    getAgent(slug) {
      return getAgentCached(slug);
    },

    async getAgentVersion(slug) {
      const cached = versionCache.get(slug);
      if (cached !== undefined) return cached;
      const gen = readEpoch.current();
      const value = await agents.getVersion(slug);
      if (readEpoch.isCurrent(gen)) versionCache.set(slug, value);
      return value;
    },

    async getWorkerCode(slug) {
      const record = await getAgentCached(slug);
      if (!record) return null;
      return readBlobCached(record.worker_hash);
    },

    async getClientFile(slug, filePath) {
      const record = await getAgentCached(slug);
      const fileHash = record?.client_files[filePath];
      if (!fileHash) return null;
      return readBlobCached(fileHash);
    },

    async deleteAgent(slug) {
      invalidate(slug);
      // The row delete is what un-publishes the agent; blobs are left as
      // orphans on purpose (content-addressed blobs may be shared with
      // another agent's identical file, so no referrer may delete them).
      await Promise.all([
        agents.delete(slug),
        // Delete-only sweep of this agent's SecretStore entries. The
        // app-db credentials go too; the caller (delete route) is
        // responsible for deprovisioning the database itself first.
        secrets.delete(agentEnvSecretName(slug)),
        secrets.delete(appDbSecretName(slug)),
      ]);
      invalidate(slug);
    },

    async getEnv(slug) {
      // Existence-gated: env for an unknown agent reads as null, not {}.
      // The env itself is read fresh from the SecretStore every time —
      // secret changes never need cache invalidation, they simply apply to
      // the next sandbox build.
      if ((await getAgentCached(slug)) === null) return null;
      return loadEnv(slug);
    },

    putEnv(slug, env) {
      return withLock(envLock, slug, async () => {
        // The existence check keeps putEnv's contract: env for an unknown
        // agent is an error, not a silent secret write.
        if ((await getAgentCached(slug)) === null) throw new Error(`Agent ${slug} not found`);
        await writeEnv(slug, env);
      });
    },

    invalidate,
  };
}
