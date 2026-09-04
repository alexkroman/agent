// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `uploads`.
 *
 * A run's file storage: the store interface, the two blob backends, the
 * part addressing, and the two failures a caller has to tell apart.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createHttpUploadBackend,
  createMemoryUploadBackend,
  type HttpUploadBackendOptions,
  partKey,
  partsOf,
  UPLOAD_KEY_PREFIX,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  UPLOADS_TABLE,
  type UploadBackend,
  type UploadMeta,
  type UploadPart,
  type UploadStore,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "../../runtime-barrel.ts";
