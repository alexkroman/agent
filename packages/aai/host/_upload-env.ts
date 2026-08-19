// Copyright 2026 the AAI authors. MIT license.
/**
 * The three env keys that say where an upload's bytes go.
 *
 * Their own module because two things need them and one of those is UNDERNEATH the
 * other: `workflow-uploads.ts` reads them to build the store, and
 * `_upload-blobs-http.ts` names them in the failure a missing bucket produces. Left in
 * the factory, that second use is an import cycle — biome says so — and the alternative
 * is a byte backend spelling the key names itself, which is exactly where two copies
 * drift apart.
 */

/** Env key naming the Storage origin uploads are written to. */
export const UPLOAD_STORAGE_URL_ENV = "AAI_UPLOAD_STORAGE_URL";
/** Env key holding the service key for {@link UPLOAD_STORAGE_URL_ENV}. */
export const UPLOAD_STORAGE_KEY_ENV = "AAI_UPLOAD_STORAGE_KEY";
/** Env key naming the bucket within it. */
export const UPLOAD_STORAGE_BUCKET_ENV = "AAI_UPLOAD_STORAGE_BUCKET";
