// Copyright 2026 the AAI authors. MIT license.
/**
 * Blob storage for deploy artifacts: the content-addressed `blobs/<sha256>`
 * objects a deploy writes (worker bundle + client files) and every session,
 * broker call, and asset fetch reads back.
 *
 * Production is Supabase Storage through its OWN client
 * (`@supabase/storage-js`), authenticated with the service-role key the
 * platform already requires for Realtime. What this replaced: unstorage's
 * generic S3 driver over `aws4fetch` SigV4, plus a 144-line local override of
 * the driver's `getKeys` (`s3-storage.ts`) that existed because the stock one
 * lists the whole bucket and reads only the first 1000-key page. Two things
 * made that stack pure cost:
 *
 * - **Nothing lists keys anymore.** Workspaces moved to Postgres, so the
 *   bucket holds only content-addressed blobs, addressed by hash. The
 *   override's entire reason for existing had already gone away, and with it
 *   the `fast-xml-parser` ListObjectsV2 decoding and its
 *   byte-exact-object-key hazards.
 * - **The S3 endpoint was a THIRD credential** for a project we already hold
 *   two for (`SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Storage's own
 *   API takes the service-role key, so `SUPABASE_S3_ENDPOINT` /
 *   `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_REGION` all come out of the
 *   deployment secret.
 *
 * The surface is deliberately the two operations the bundle store actually
 * performs. It is NOT a generic key-value store: no listing, no delete (a
 * blob is immutable and shared across deploys — see bundle-store.ts on why
 * orphans are accepted), no iteration. Anything wanting more should ask
 * whether it really wants a Postgres row.
 *
 * **"No delete" is about this INTERFACE, not about the bucket.** Objects are
 * reclaimed, by `aai-sweep-blob-gc` (`pg-cron-bodies.ts`) — mark-and-sweep from
 * pg_cron through the Storage API, one arm for `blobs/` and one for `uploads/`.
 * It is there rather than here because reclamation has to run exactly once
 * platform-wide on a schedule that survives replica churn, which an in-process
 * client held by every replica cannot do. So a delete method added here would
 * have no caller; what it would have is the appearance of one, which is how a
 * second deleter with a different rule gets written.
 */

import { errorMessage } from "@alexkroman1/aai";
import { StorageClient } from "@supabase/storage-js";
import { createLogger } from "./logger.ts";
import {
  isStorageUnavailable,
  PlatformServiceUnavailableError,
  storageFailureCause,
} from "./platform-service-errors.ts";

const log = createLogger("storage.blob");

/**
 * The blob operations the bundle store needs. Two implementations, matching
 * every other platform store: Supabase Storage in production, memory in
 * dev/tests.
 */
export type BlobStorage = {
  /** Blob content, or null when the key has never been written. */
  getItem(key: string): Promise<string | null>;
  /**
   * Write blob content. Idempotent by construction — keys are content
   * hashes, so a rewrite is byte-identical to what is already there.
   */
  setItem(key: string, value: string): Promise<void>;
  /**
   * A time-boxed, object-scoped read URL for one blob, or null when this
   * backend cannot mint one (the memory store) — the caller then falls back
   * to reading the bytes itself.
   *
   * This exists so a guest sandbox can pull its own worker bundle instead of
   * the platform reading ~8 MB out of Storage and pushing the same bytes into
   * the sandbox — the bundle crossed the platform twice for no reason. The
   * URL carries no service-role key, grants read of exactly this key, and
   * expires; the guest hash-verifies what it gets against the agents row's
   * `worker_hash` before loading it, so nothing about the delivery path is
   * trusted (see aai-guest/harness-agent-mode.ts).
   *
   * Null means **this backend cannot sign at all** (the memory store, which
   * has no server in front of it), not "signing failed" — a failure THROWS
   * and fails the spawn, like every other Storage error here. There is no
   * quiet downgrade to reading the bytes: that would make the byte path
   * reachable in production without anything reporting it, which is how a
   * regression in the fast path stays invisible.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string | null>;
};

export type SupabaseBlobStorageOptions = {
  /** Project URL (`https://<ref>.supabase.co`) — `/storage/v1` is appended. */
  url: string;
  /** Service-role key; the same one the Realtime socket authenticates with. */
  serviceRoleKey: string;
  bucket: string;
  /** Test seam — production uses the client's own fetch. */
  fetch?: typeof globalThis.fetch;
};

/** `https://<ref>.supabase.co` → `https://<ref>.supabase.co/storage/v1`. */
export function storageEndpoint(url: string): string {
  return `${url.replace(/\/+$/, "")}/storage/v1`;
}

/** One year, the ceiling `max-age` is meaningful at (RFC 9111). */
const BLOB_MAX_AGE_SECONDS = 31_536_000;

/**
 * Blobs are UTF-8 JavaScript/CSS/HTML text, so they go up as `text/plain`
 * with `upsert`. Upsert rather than insert because a redeploy of unchanged
 * content writes the same hash again: an insert would 409 on every no-op
 * deploy, and treating "already exists" as success by inspecting the error
 * string is exactly the kind of check that breaks when a message is reworded.
 */
const UPLOAD_OPTIONS = {
  contentType: "text/plain;charset=utf-8",
  // Seconds, rendered by Storage as the object's `Cache-Control: max-age`.
  // A year is correct BY CONSTRUCTION rather than as a guess: the key is the
  // content hash, so an object's bytes can never change under its own name —
  // the same reasoning that lets the asset routes serve `immutable`.
  //
  // It changes nothing today, and that is the point of setting it now: every
  // read is either an authenticated `download()` (which Supabase's CDN will
  // not cache) or a per-call signed URL (a fresh token, so a fresh cache key).
  // Storage stamps this at UPLOAD time and never revisits it, so leaving it at
  // the client's 3600 default would mean every blob already written carries
  // the wrong directive on the day anything is served through the CDN — a
  // migration to fix, in exchange for nothing saved by omitting it.
  cacheControl: `${BLOB_MAX_AGE_SECONDS}`,
  upsert: true,
} as const;

function storageClient(opts: SupabaseBlobStorageOptions): StorageClient {
  return new StorageClient(
    storageEndpoint(opts.url),
    { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}` },
    opts.fetch,
  );
}

/**
 * Boot-time check that the configured bucket exists and is PRIVATE.
 *
 * Everything else about this platform's Supabase state is declared and
 * reviewable — schema, publication, grants, RLS, extensions, queues, all in
 * `supabase/migrations`. The bucket is the exception: it is created and
 * configured in the dashboard, and `supabase/config.toml` deliberately omits
 * storage settings so there is no second source of truth for something
 * nothing applies. That is the right call for auth and realtime settings and
 * the wrong one for this, because "is this bucket public" is a one-bit
 * property deciding whether every tenant's worker bundle is world-readable,
 * and no migration, test, or request would ever notice it flipping.
 *
 * **A misconfiguration is fatal; an unreachable Storage is not.** The
 * distinction is the whole design. `assertServiceRoleKey` and
 * `assertSessionModeUrl` are local, total functions — they can refuse boot
 * because they cannot be wrong about a transient. This one is a network call,
 * so failing boot on any error would turn a Storage blip into a
 * fleet-wide crash-loop: every container refusing to start at once, which is
 * far worse than the thing being guarded against. So a bucket that answers
 * and is misconfigured throws, a bucket that answers 404 throws, and anything
 * else warns and lets the service come up — where the first deploy will
 * report it in a way an operator can act on.
 */
export async function assertBucketPrivate(opts: SupabaseBlobStorageOptions): Promise<void> {
  const { data, error } = await storageClient(opts).getBucket(opts.bucket);
  if (error && isNotFound(error)) {
    throw new Error(
      `Supabase Storage bucket "${opts.bucket}" does not exist. SUPABASE_STORAGE_BUCKET names ` +
        "the bucket deploy artifacts are written to; create it (private) or correct the variable.",
    );
  }
  if (error || !data) {
    log.warn(
      `could not verify bucket "${opts.bucket}" — continuing, this is a reachability ` +
        "failure rather than a configuration one",
      { error: errorMessage(error) },
    );
    return;
  }
  if (data.public) {
    throw new Error(
      `Supabase Storage bucket "${opts.bucket}" is PUBLIC. Deploy artifacts are every tenant's ` +
        "worker bundles and client files, and the platform hands them out through per-call " +
        "signed URLs precisely so they are not world-readable. Make the bucket private.",
    );
  }
}

/** The `service` every unavailability from this module carries. */
const STORAGE_SERVICE = "supabase-storage";

/** Supabase Storage-backed blob storage (production). */
export function createSupabaseBlobStorage(opts: SupabaseBlobStorageOptions): BlobStorage {
  const client = storageClient(opts);
  // `from` is a pure accessor over the client — no per-call state, so one
  // handle serves every read and write.
  const bucket = client.from(opts.bucket);

  return {
    async getItem(key) {
      const { data, error } = await bucket.download(key);
      if (error) {
        // A miss and a failure are different answers and the caller
        // distinguishes them (bundle-store caches misses under a sentinel and
        // retries transient failures), so a missing object must resolve null
        // while anything else throws. storage-js reports both as `error`;
        // the HTTP status is what separates them.
        if (isNotFound(error)) return null;
        throw blobFailure("read", key, error);
      }
      return await data.text();
    },

    async setItem(key, value) {
      const { error } = await bucket.upload(key, value, UPLOAD_OPTIONS);
      if (error) {
        throw blobFailure("write", key, error);
      }
    },

    async signedUrl(key, ttlSeconds) {
      // Unlike getItem, a 404 is NOT special-cased to null: null is reserved
      // for "this backend cannot sign", and a signing call for a key the row
      // says exists is a broken deploy either way.
      const { data, error } = await bucket.createSignedUrl(key, ttlSeconds);
      if (error || !data?.signedUrl) {
        throw blobFailure("signing", key, error);
      }
      return data.signedUrl;
    },
  };
}

/**
 * A 404 from Storage — "this object does not exist" rather than "the read
 * failed". storage-js surfaces the status on its error objects but does not
 * type it, so read it structurally and treat an unrecognizable error as a
 * failure: mistaking a transient 5xx for a miss would make a deploy look
 * like it had never happened.
 */
function isNotFound(error: unknown): boolean {
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
  return Number(statusCode ?? status) === 404;
}

/**
 * One storage-js failure, typed by whether Storage was REACHABLE.
 *
 * The message is unchanged — three call sites already agreed on
 * `blob <verb> failed for <key>` and it is what the specs read — so the two
 * things this adds are both invisible at the call site:
 *
 * - **The class**, so `createErrorHandler` answers 503 for a dependency that
 *   could not be reached. `POST /deploy` answered 500 on `fetch failed` during
 *   a burst of concurrent uploads, which tells a client not to retry the one
 *   failure that retrying fixes.
 * - **The `cause`**, re-parented off `originalError`. Without it the log said
 *   `fetch failed` and stopped, which is undici's message for every network
 *   failure and names none of them.
 *
 * A 404 never arrives here — `getItem` resolves that to `null` above, because
 * its callers cache a miss and retry a failure.
 */
function blobFailure(verb: string, key: string, error: unknown): Error {
  const message = `blob ${verb} failed for ${key}: ${errorMessage(error)}`;
  const cause = storageFailureCause(error);
  return isStorageUnavailable(error)
    ? new PlatformServiceUnavailableError(STORAGE_SERVICE, message, { cause })
    : new Error(message, { cause });
}

/** In-memory blob storage for local dev and tests. */
export function createMemoryBlobStorage(): BlobStorage {
  const blobs = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(blobs.get(key) ?? null),
    setItem: (key, value) => {
      blobs.set(key, value);
      return Promise.resolve();
    },
    // No URL to hand out: there is no server in front of this Map. Callers
    // read the bytes, which is exactly the pre-signing behaviour and the only
    // path local dev and tests ever take.
    signedUrl: () => Promise.resolve(null),
  };
}
