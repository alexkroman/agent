// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload store: one store (`store-blobs.ts`) over an `UploadRecords` (the
 * record — Postgres in `records.ts`, the platform's in `platform.ts`, files in
 * `files.ts`) and an `UploadBackend` (one object per `UPLOAD_PART_BYTES` window —
 * memory, HTTP bucket or brokered, `blobs*.ts`), plus the store's error
 * vocabulary (`store.ts`). Outside this directory, import from here; a name not
 * re-exported here is private to it (guard-invariants rule 37).
 */

export type { UploadBackend, UploadPart } from "./blobs.ts";
export { createMemoryUploadBackend, partKey, partsCovering, partsOf, rangesOf } from "./blobs.ts";
export { createBrokeredUploadBlobs } from "./blobs-brokered.ts";
export type { HttpUploadBackendOptions } from "./blobs-http.ts";
export { createHttpUploadBackend } from "./blobs-http.ts";
export {
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
} from "./env.ts";
export { createFileUploadBlobs, createFileUploadRecords } from "./files.ts";
export type { PlatformUploadRecordsOptions } from "./platform.ts";
export { createPlatformUploadRecords } from "./platform.ts";
export { createPostgresUploadRecords } from "./records.ts";
export type { ByteRange, UploadMeta, UploadStore } from "./store.ts";
export {
  assertPartOffset,
  assertPartTotal,
  contiguousBytes,
  UnknownUploadError,
  UPLOAD_WINDOW_CONCURRENCY,
  UPLOADS_TABLE,
  UploadCompleteError,
  UploadIdTakenError,
  UploadPartError,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "./store.ts";
export { createBlobUploadStore } from "./store-blobs.ts";
