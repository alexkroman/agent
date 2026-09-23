// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `uploads`.
 *
 * A run's file storage as an operator and a caller see it: the bucket
 * configuration an operator sets, the record shapes a step reads back, and the
 * two failures a caller has to tell apart.
 *
 * The store, its two blob backends, the part addressing and the table name are
 * `@alexkroman1/aai-runtime/internal`'s: `createRuntimeServer` builds the store
 * and no public signature takes or returns one.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  UPLOAD_KEY_PREFIX,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  type UploadMeta,
  type UploadPart,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "../../runtime-barrel.ts";
