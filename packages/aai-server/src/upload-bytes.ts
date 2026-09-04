// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a workflow upload's BYTES live, from the platform's side.
 *
 * A deployed guest holds no bucket credential — it runs tenant code, and the bucket
 * is platform-wide, so a service key in a guest is a cross-tenant read of every
 * agent's uploads and every agent's worker bundle. What the guest gets instead is a
 * URL: `PUT/GET/HEAD /:slug/uploads/:id/:offset`, which `upload-handler.ts` serves
 * and this module is the storage behind. The guest end is
 * `aai/host/_upload-blobs-brokered.ts`; the argument for the split is
 * `aai/host/_upload-blobs.ts`, "Signing is NOT here".
 *
 * ## The same bucket as deploy blobs, under a different prefix
 *
 * `uploads/<slug>/<id>/<offset>` beside `blobs/<sha256>`. One bucket rather than a
 * second one because there is nothing to separate: `assertBucketPrivate` already
 * covers it, the credential is the same, and a second `SUPABASE_*_BUCKET` is another
 * variable a deployment can half-configure.
 *
 * What makes that safe is that `aai-sweep-blob-gc` (pg-cron.ts) sweeps the bucket
 * PER PREFIX, with a referrer set per arm. Its blobs arm matches
 * `name like 'blobs/%'`, and without that clause it would delete every upload in
 * the bucket on its first run — an upload has no `worker_hash` and no
 * `client_files` entry to be found by. Its uploads arm matches this prefix and
 * takes the `workflow_uploads` row as the referrer instead.
 *
 * **Anything else put in this bucket owes an arm of its own, or it is not swept
 * at all.** That is the cost of one bucket and it is not hypothetical: uploads
 * lived here for the whole life of this module with no arm, so nothing ever
 * reclaimed an uploaded byte — not agent delete, not the 7-day record expiry, not
 * the GC. A new prefix defaults to leaking, silently, and the leak is somebody
 * else's storage bill and somebody else's recordings.
 *
 * ## `readUrl` is the one operation that is NOT a byte move
 *
 * A read is a fan-out: sixty steps each want their own window of one recording, so
 * a 200 MB file is read back in full, and answering those from here would move it
 * through the platform twice per run. So the route SIGNS and redirects, and the
 * guest's `fetch` follows the 302 to Storage with its `Range` header intact — the
 * same trick, and the same reasoning, as the guest fetching its own worker bundle
 * (`BlobStorage.signedUrl`).
 *
 * `null` means **this backend cannot sign at all** (the memory one, which has no
 * server in front of it), never "signing failed" — a failure THROWS, exactly as in
 * `blob-storage.ts`. The route then serves the window itself, which is the only path
 * `aai dev` and the tests ever take.
 */

import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import {
  createHttpUploadBackend,
  createMemoryUploadBackend,
  UPLOAD_KEY_PREFIX,
  type UploadBackend,
} from "@alexkroman1/aai-runtime";
import { StorageClient } from "@supabase/storage-js";
import { type SupabaseBlobStorageOptions, storageEndpoint } from "./blob-storage.ts";

/**
 * How long a signed read URL is good for.
 *
 * Long enough for one step to read its window over a slow link, short enough that a
 * URL leaking out of a log is not a standing capability. A step's read is a single
 * request, so this bounds the request rather than the run.
 */
export const UPLOAD_READ_URL_TTL_SECONDS = 300;

/** The byte operations the platform's upload route performs, and only those. */
export type UploadBytes = UploadBackend & {
  /**
   * A time-boxed, object-scoped read URL, or `null` when this backend cannot mint
   * one — see the module doc for why that is not the same as a failure.
   */
  readUrl(key: string, ttlSeconds: number): Promise<string | null>;
};

/**
 * Where one agent's upload object lives, composed HERE from the slug.
 *
 * The root is the runtime's own `UPLOAD_KEY_PREFIX`, so the two sides of this
 * bucket cannot drift apart on where uploads begin. The SHAPE below it is the
 * platform's and deliberately not the runtime's `partKey`: this route writes
 * into a bucket shared by every tenant, so the slug is interposed.
 */
export function uploadKey(slug: string, id: string, offset: number): string {
  return `${UPLOAD_KEY_PREFIX}/${slug}/${id}/${offset}`;
}

/**
 * Supabase Storage-backed upload bytes (production).
 *
 * The byte half is `createHttpUploadBackend`, which is the SDK's own implementation —
 * the same code the `aai dev` path runs, so a guest brokering through this route and
 * a dev server talking to a bucket directly cannot diverge in how an object is
 * written or how a window is read. The signing half is storage-js, which is already
 * a dependency here and is what `blob-storage.ts` signs deploy blobs with.
 */
export function createSupabaseUploadBytes(opts: SupabaseBlobStorageOptions): UploadBytes {
  const blobs = createHttpUploadBackend({
    url: opts.url,
    serviceKey: opts.serviceRoleKey,
    bucket: opts.bucket,
    ...omitUndefined({ fetch: opts.fetch }),
  });
  const bucket = new StorageClient(
    storageEndpoint(opts.url),
    { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}` },
    opts.fetch,
  ).from(opts.bucket);

  return {
    ...blobs,
    async readUrl(key, ttlSeconds) {
      const { data, error } = await bucket.createSignedUrl(key, ttlSeconds);
      if (error || !data?.signedUrl) {
        throw new Error(`upload signing failed for ${key}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      return data.signedUrl;
    },
  };
}

/** In-memory upload bytes for local dev and tests. */
export function createMemoryUploadBytes(): UploadBytes {
  return {
    ...createMemoryUploadBackend(),
    // No URL to hand out: there is no server in front of a Map. The route reads the
    // window instead, which is exactly the pre-signing behaviour.
    readUrl: () => Promise.resolve(null),
  };
}
