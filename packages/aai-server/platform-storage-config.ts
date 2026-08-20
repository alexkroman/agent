// Copyright 2026 the AAI authors. MIT license.
/**
 * Where deploy artifacts and upload windows live, resolved from the environment.
 *
 * Split out of `service-config.ts` when it went over the file-length cap. It is a
 * genuine seam rather than a convenient one: everything else in that file answers
 * "where does platform STATE live and how do we connect to it", and this answers
 * "where do the BYTES go" — a different backend (Supabase Storage, not Postgres),
 * a different credential, and a check that makes a network call.
 *
 * The one rule worth keeping in front of a reader: `assertStorageBucket` is
 * SEPARATE from `buildStorage` because it is async and that one is not. The entry
 * awaits it once beside the other boot assertions, rather than every construction
 * of a storage handle paying a round trip.
 */

import { hasPlatformDb, requireEnv } from "./_boot.ts";
import {
  assertBucketPrivate,
  type BlobStorage,
  createMemoryBlobStorage,
  createSupabaseBlobStorage,
  type SupabaseBlobStorageOptions,
} from "./blob-storage.ts";
import { createLogger } from "./logger.ts";
import {
  createMemoryUploadBytes,
  createSupabaseUploadBytes,
  type UploadBytes,
} from "./upload-bytes.ts";

const log = createLogger("platform.storage");

/**
 * Verify the deploy-artifact bucket at boot — see {@link assertBucketPrivate}
 * for what is fatal and what merely warns.
 *
 * Separate from {@link buildStorage} because it is ASYNC and that one is not:
 * the entry awaits this once, beside the other boot assertions, rather than
 * every construction of a storage handle paying a round trip.
 */
export async function assertStorageBucket(env: NodeJS.ProcessEnv): Promise<void> {
  // No platform database is the memory blob store — there is no bucket to check.
  if (!hasPlatformDb(env)) return;
  await assertBucketPrivate(storageOptions(env));
}

/**
 * The three settings Supabase Storage needs, required together.
 *
 * One reader, because the check and the construction below must demand the same
 * three: a variable missing from one list would make boot verify a bucket the
 * handles never write to, or the reverse.
 */
function storageOptions(env: NodeJS.ProcessEnv): SupabaseBlobStorageOptions {
  const required = requireEnv(env, [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_STORAGE_BUCKET",
  ]);
  return {
    url: required.SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    bucket: required.SUPABASE_STORAGE_BUCKET,
  };
}

/**
 * Where a workflow upload's WINDOWS live — the same bucket, under `uploads/`.
 *
 * The same three settings and the same credential, because it is the same bucket:
 * `upload-bytes.ts` carries why one bucket rather than two, and the prefix filter in
 * `aai-sweep-blob-gc` that makes sharing it safe.
 *
 * Memory without a platform database, exactly like `buildStorage` — and with the same
 * consequence, said out loud for the same reason: those windows are lost on restart.
 * There is no third tier where a bucket exists and the database does not.
 */
export function buildUploadBytes(env: NodeJS.ProcessEnv): UploadBytes {
  if (!hasPlatformDb(env)) {
    log.info(
      "no SUPABASE_DB_URL: in-memory storage for workflow upload bytes — " +
        "uploads are LOST on restart",
    );
    return createMemoryUploadBytes();
  }
  return createSupabaseUploadBytes(storageOptions(env));
}

export function buildStorage(env: NodeJS.ProcessEnv): BlobStorage {
  if (!hasPlatformDb(env)) {
    log.info(
      "no SUPABASE_DB_URL: in-memory blob storage for deploy artifacts — " +
        "deploys are LOST on restart",
    );
    return createMemoryBlobStorage();
  }
  // Storage authenticates with the SAME service-role key the Realtime socket
  // uses — no separate S3 credential pair for a project we already hold two
  // credentials for (see blob-storage.ts).
  return createSupabaseBlobStorage(storageOptions(env));
}
