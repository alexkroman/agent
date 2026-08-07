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
 */

import { errorMessage } from "@alexkroman1/aai";
import { StorageClient } from "@supabase/storage-js";

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

/**
 * Blobs are UTF-8 JavaScript/CSS/HTML text, so they go up as `text/plain`
 * with `upsert`. Upsert rather than insert because a redeploy of unchanged
 * content writes the same hash again: an insert would 409 on every no-op
 * deploy, and treating "already exists" as success by inspecting the error
 * string is exactly the kind of check that breaks when a message is reworded.
 */
const UPLOAD_OPTIONS = { contentType: "text/plain;charset=utf-8", upsert: true } as const;

/** Supabase Storage-backed blob storage (production). */
export function createSupabaseBlobStorage(opts: SupabaseBlobStorageOptions): BlobStorage {
  const client = new StorageClient(
    storageEndpoint(opts.url),
    { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}` },
    opts.fetch,
  );
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
        throw new Error(`blob read failed for ${key}: ${errorMessage(error)}`, { cause: error });
      }
      return await data.text();
    },

    async setItem(key, value) {
      const { error } = await bucket.upload(key, value, UPLOAD_OPTIONS);
      if (error) {
        throw new Error(`blob write failed for ${key}: ${errorMessage(error)}`, { cause: error });
      }
    },

    async signedUrl(key, ttlSeconds) {
      // Unlike getItem, a 404 is NOT special-cased to null: null is reserved
      // for "this backend cannot sign", and a signing call for a key the row
      // says exists is a broken deploy either way.
      const { data, error } = await bucket.createSignedUrl(key, ttlSeconds);
      if (error || !data?.signedUrl) {
        throw new Error(`blob signing failed for ${key}: ${errorMessage(error)}`, { cause: error });
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
