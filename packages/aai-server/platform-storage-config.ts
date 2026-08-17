// Copyright 2026 the AAI authors. MIT license.
/**
 * Where deploy artifacts live, resolved from the environment.
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
} from "./blob-storage.ts";

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
  const required = requireEnv(env, [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_STORAGE_BUCKET",
  ]);
  await assertBucketPrivate({
    url: required.SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    bucket: required.SUPABASE_STORAGE_BUCKET,
  });
}

export function buildStorage(env: NodeJS.ProcessEnv): BlobStorage {
  if (!hasPlatformDb(env)) {
    console.info(
      "No SUPABASE_DB_URL: in-memory blob storage for deploy artifacts — " +
        "deploys are LOST on restart",
    );
    return createMemoryBlobStorage();
  }
  // Storage authenticates with the SAME service-role key the Realtime socket
  // uses — no separate S3 credential pair for a project we already hold two
  // credentials for (see blob-storage.ts).
  const required = requireEnv(env, [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_STORAGE_BUCKET",
  ]);
  return createSupabaseBlobStorage({
    url: required.SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    bucket: required.SUPABASE_STORAGE_BUCKET,
  });
}
