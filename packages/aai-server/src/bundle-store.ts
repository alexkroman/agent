// Copyright 2025 the AAI authors. MIT license.
// Bundle store: agents rows (Postgres in production — see agent-store.ts)
// pointing at content-addressed blobs in a BlobStorage (Supabase Storage in
// production — see blob-storage.ts), plus a SecretStore for agent env records.
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
import { LRUCache } from "lru-cache";
import { createKeyedLock, withLock } from "./_keyed-lock.ts";
import { createSingleFlight, type SingleFlight } from "./_memo.ts";
import { mapConcurrent } from "./_pool.ts";
import { retryOnTransient } from "./_retry.ts";
import { TtlCache } from "./_ttl-cache.ts";
import type { AgentRecord, AgentRows } from "./agent-store.ts";
import type { BlobStorage } from "./blob-storage.ts";
import { envCount, MAX_ENV_SIZE } from "./constants.ts";
import { createLogger } from "./logger.ts";
import { EnvSchema } from "./schemas.ts";
import { agentEnvSecretName, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("store.bundle");

/**
 * How many of a deploy's blobs are written to Storage AT ONCE.
 *
 * Here rather than in `constants.ts` because it is this concern's number and not
 * a term in the connection budget — the same placement rule
 * `LOGS_READY_TIMEOUT_MS` follows, and that file is at its line cap.
 *
 * A deploy's blob writes are independent by construction — content-addressed
 * keys, `upsert: true`, nothing references them until the row lands — so they go
 * out together rather than one at a time. What they had no bound on was HOW MANY
 * together: `DeployBodySchema` permits 100 client files, so one deploy was up to
 * 102 simultaneous PUTs at a single Supabase Storage endpoint, and
 * `DEPLOY_BODY_CONCURRENCY` allows two deploys in flight — ~204 sockets from one
 * replica, a width set by the caller's payload rather than by us.
 *
 * That is the shape `_semaphore.ts` exists to refuse, and here it has a symptom
 * on record: {@link writeBlob} is wrapped in `retryOnTransient` because a single
 * reset used to fail a whole deploy, and `_retry.ts`'s code list (`ECONNRESET`,
 * `UND_ERR_SOCKET`, `UND_ERR_CONNECT_TIMEOUT`) is documented as written FOR this
 * endpoint. Those are what an S3-compatible endpoint returns to a client opening
 * far more sockets than it should, so the retry was treating this fan-out's
 * symptom.
 *
 * 12 costs a deploy almost nothing — 100 small files is nine rounds — and keeps
 * every write's retries, so it strictly reduces the number of resets there are
 * retries to spend. Override with `DEPLOY_BLOB_CONCURRENCY`.
 */
export const DEPLOY_BLOB_CONCURRENCY = envCount(process.env.DEPLOY_BLOB_CONCURRENCY, 12);

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

/**
 * Run every write, at most {@link DEPLOY_BLOB_CONCURRENCY} at a time, and settle
 * once they all have.
 *
 * The pool itself is `_pool.ts` — a worker pool rather than `_semaphore.ts`,
 * for the reason its module doc gives. What is specific here is the WIDTH and
 * what a failure means: the width was otherwise the caller's to choose (100
 * client files are permitted, so this was up to 102 simultaneous PUTs at one
 * Storage endpoint per deploy — see `DEPLOY_BLOB_CONCURRENCY`), and a deploy
 * that could not write a blob must not publish its row, so the first failure
 * rejects. The rest are not cancelled, deliberately: every key is a content
 * hash and every write idempotent, so a blob that lands for a deploy that then
 * failed is an orphan — the same orphan a superseded deploy leaves, which
 * `aai-sweep-blob-gc` already reclaims — while a half-written set the retry has
 * to redo from nothing is strictly worse.
 */
async function writeAll(writes: (() => Promise<void>)[]): Promise<void> {
  await mapConcurrent(writes, DEPLOY_BLOB_CONCURRENCY, (write) => write());
}

export function createBundleStore(
  storage: BlobStorage,
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
   *
   * PER SLUG, because a mutation only makes one slug's in-flight reads stale.
   * A single counter for the whole store (which is what this was) meant any
   * deploy discarded the cache write of every OTHER slug's concurrent read —
   * correct, since it only ever fails safe, but it re-reads Postgres for slugs
   * nothing happened to, and it does so exactly when the replica is busiest.
   *
   * The map grows only for slugs this replica has MUTATED — a read never adds
   * an entry — so it is bounded by deploy variety rather than by traffic, and
   * each entry is a slug and an integer.
   */
  const readEpochs = new Map<string, number>();
  const currentEpoch = (slug: string): number => readEpochs.get(slug) ?? 0;
  const isCurrentEpoch = (slug: string, captured: number): boolean =>
    currentEpoch(slug) === captured;

  /**
   * Single-flight over the three reads that miss together.
   *
   * Every cache above serves a read that already happened; none of them helps
   * the burst that arrives while the FIRST read is still in flight, and that
   * burst is the normal shape of a cold replica. A scale-out container taking
   * a page load issues one row read plus one blob read per asset the page
   * references, and a slug's assets are requested by the browser in parallel —
   * so N requests for one deploy became N identical Postgres reads and N
   * identical Storage downloads, precisely when the process has the least to
   * spare.
   *
   * The row flights are DROPPED by `invalidate`, and that is what keeps them
   * safe: a caller arriving after a mutation must not be served a read that
   * started before it — the same hazard the epoch guard exists for, one step
   * earlier. (The epoch still guards the cache WRITE; a joiner that predates
   * the mutation is no worse off than it is today.) Blobs need neither: a
   * content-addressed key cannot go stale, so joining any in-flight read of it
   * is always correct.
   */
  const rowFlight = createSingleFlight<AgentRecord | null>();
  const versionFlight = createSingleFlight<number | null>();
  const blobFlight = createSingleFlight<string | null>();

  function invalidate(slug: string): void {
    readEpochs.set(slug, currentEpoch(slug) + 1);
    rowCache.delete(slug);
    versionCache.delete(slug);
    rowFlight.drop(slug);
    versionFlight.drop(slug);
  }

  /**
   * One read-through for the two ROW caches: serve the cache, else join (or
   * start) the single flight, and write the answer back only if no mutation
   * landed while it was in the air.
   *
   * The row and version reads had this written out twice, differing in nothing
   * but which cache and which flight they name — so the epoch guard, which is
   * the subtle half (see `readEpochs`), existed in two places that had to agree.
   */
  function cachedSlugRead<T>(
    cache: TtlCache<T>,
    flight: SingleFlight<T>,
    slug: string,
    read: () => Promise<T>,
  ): Promise<T> {
    const cached = cache.get(slug);
    if (cached !== undefined) return Promise.resolve(cached);
    return flight.run(slug, async () => {
      const gen = currentEpoch(slug);
      const value = await read();
      if (isCurrentEpoch(slug, gen)) cache.set(slug, value);
      return value;
    });
  }

  /**
   * A blob operation, retrying the transient network failures `_retry.ts`
   * describes. `verb` only names the operation in the log line — reads and
   * writes retry identically, and both are safe to retry for the same reason:
   * the key is a content hash (see {@link writeBlob}).
   */
  function retryBlobOp<T>(verb: string, key: string, op: () => Promise<T>): Promise<T> {
    return retryOnTransient(op, {
      onRetry: (attempt, attempts, err) => {
        log.warn(`transient storage error ${verb} ${key}`, {
          attempt,
          attempts,
          error: errorMessage(err),
        });
      },
    });
  }

  function readBlob(contentHashHex: string): Promise<string | null> {
    const key = blobKey(contentHashHex);
    return retryBlobOp("reading", key, () => storage.getItem(key));
  }

  /**
   * Write one blob, retrying the same transient network failures reads retry.
   *
   * The read path has been wrapped since `_retry.ts` was written — and its
   * code list (`ECONNRESET`, `UND_ERR_SOCKET`, …) was written FOR this
   * endpoint, describing "body-phase socket failures from fetch() against
   * S3-compatible endpoints (Supabase Storage)". The write path is strictly
   * more exposed to those: it moves the ~8 MB worker bundle plus every client
   * file, where a read of the same deploy usually moves nothing (the caches
   * above serve it). Unwrapped, one reset on any single file failed the whole
   * deploy — and for studio Publish that surfaces to a user as a build failure
   * carrying a network message.
   *
   * Retrying is safe BY CONSTRUCTION rather than by argument: the key is the
   * content hash and `UPLOAD_OPTIONS` sets `upsert: true` (blob-storage.ts),
   * so a retry rewrites byte-identical content to the same key. That is the
   * same property `putAgent` already relies on to write blobs before the row.
   */
  function writeBlob(contentHashHex: string, content: string): Promise<void> {
    const key = blobKey(contentHashHex);
    return retryBlobOp("writing", key, () => storage.setItem(key, content));
  }

  function readBlobCached(contentHashHex: string): Promise<string | null> {
    const cached = blobCache.get(contentHashHex);
    if (cached !== undefined) return Promise.resolve(cached === BLOB_MISS ? null : cached);
    return blobFlight.run(contentHashHex, async () => {
      const value = await readBlob(contentHashHex);
      // Cache misses too (BLOB_MISS): a hash referenced by a row either exists
      // or the deploy that wrote the row failed mid-blob-write — both stable.
      blobCache.set(contentHashHex, value ?? BLOB_MISS);
      return value;
    });
  }

  function getAgentCached(slug: string): Promise<AgentRecord | null> {
    return cachedSlugRead(rowCache, rowFlight, slug, () => agents.get(slug));
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
      // Hashed ONCE per file, and the hash is carried alongside its content:
      // re-deriving it through the path→hash map on the write side needed a
      // `?? ""` fallback for a lookup that cannot miss, which is a blob written
      // under an empty key if it ever did.
      const clientBlobs = Object.entries(bundle.clientFiles).map(
        ([path, content]) => [path, contentHash(content), content] as const,
      );
      const clientFiles = Object.fromEntries(
        clientBlobs.map(([path, fileHash]) => [path, fileHash]),
      );

      // Blobs and env first — all immutable or idempotent writes to keys
      // nothing references yet, so they overlap. Only after every one has
      // landed does the row upsert publish the deploy.
      //
      // BOUNDED, because the width was otherwise the caller's to choose: 100
      // client files are permitted, so this was up to 102 simultaneous PUTs at
      // one Storage endpoint per deploy. See `DEPLOY_BLOB_CONCURRENCY` for why
      // that is the fan-out the retries below were quietly paying for.
      await writeAll([
        () => writeEnv(bundle.slug, bundle.env),
        () => writeBlob(workerHash, bundle.worker),
        ...clientBlobs.map(
          ([, fileHash, content]) =>
            () =>
              writeBlob(fileHash, content),
        ),
      ]);

      await agents.put({
        slug: bundle.slug,
        credential_hashes: bundle.credential_hashes,
        worker_hash: workerHash,
        client_files: clientFiles,
        harness_image_tag: bundle.harnessImageTag ?? null,
      });

      // Drop this replica's row caches so the next read sees the new deploy
      // immediately (peers converge via their version checks).
      invalidate(bundle.slug);
    },

    async touchAgent(slug) {
      // Same invalidate-around-the-write shape as `putAgent`/`deleteAgent`:
      // the bump IS the cross-replica signal, and this replica's own caches
      // have to stop answering with the old version for it to act on its own
      // event.
      invalidate(slug);
      const bumped = await agents.touch(slug);
      invalidate(slug);
      return bumped;
    },

    getAgent(slug) {
      return getAgentCached(slug);
    },

    getAgentVersion(slug) {
      return cachedSlugRead(versionCache, versionFlight, slug, () => agents.getVersion(slug));
    },

    async getWorkerCode(slug) {
      const record = await getAgentCached(slug);
      if (!record) return null;
      return readBlobCached(record.worker_hash);
    },

    async getWorkerUrl(slug, ttlSeconds) {
      const record = await getAgentCached(slug);
      if (!record) return null;
      // No retryOnTransient wrapper, unlike readBlob: signing moves no bytes
      // and the guest's own fetch is where a transient failure would actually
      // show up. A throw here fails the spawn, which is retried by the caller
      // re-brokering — the shape every other spawn failure takes.
      return storage.signedUrl(blobKey(record.worker_hash), ttlSeconds);
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
        // Delete-only sweep of this agent's SecretStore entries. There is one
        // entry per agent now — an `app-db:<slug>` credential went with per-app
        // databases, and a legacy row is deliberately NOT swept here: deleting
        // the only credential for a database that still exists strands the data,
        // which is the "leaked, out loud" failure `orphan-previews.ts` names.
        secrets.delete(agentEnvSecretName(slug)),
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
