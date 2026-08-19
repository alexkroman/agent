// Copyright 2026 the AAI authors. MIT license.
/**
 * Where an uploaded file lives between the form that sent it and the step that
 * reads it — the factory, and the one import path for the store.
 *
 * The problem it solves is the one `MAX_WORKFLOW_INPUT_BYTES` states: a run's input
 * is journaled and replayed on every resume, so bytes may not travel in it. Before
 * this the only answer was "put the file somewhere else and pass a URL", which is
 * fine for a recording that is already hosted and useless for a person with a file
 * on their laptop.
 *
 * **`_upload-store.ts` is the contract** — the types, the chunking, and the
 * invariants every reader depends on (an ordinary upload does not exist until it is
 * finished; a STREAMED one exists from its first byte and says so with `complete`;
 * a PARTS one arrives over several connections at once and publishes only its
 * contiguous prefix as `size`).
 * Read it before changing a backend. The backends themselves are
 * `_upload-store-postgres.ts` (the deployed case, and the only durable one) and
 * `_upload-store-files.ts` (`aai dev` with no `DATABASE_URL`).
 *
 * This module re-exports the contract's names so it stays the ONE import path for
 * the store: `runtime-barrel.ts` and six call sites already name it, and the split
 * into backends is packaging rather than a move of the public surface.
 */

import { MAX_WORKFLOW_UPLOAD_BYTES } from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import type { UploadStore } from "./_upload-store.ts";
import { createFileUploadStore } from "./_upload-store-files.ts";
import { createPostgresUploadStore } from "./_upload-store-postgres.ts";

export {
  assertPartOffset,
  assertPartTotal,
  type ByteRange,
  contiguousBytes,
  mergeRanges,
  UnknownUploadError,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  UploadIdTakenError,
  type UploadMeta,
  UploadPartError,
  type UploadStore,
  UploadTooLargeError,
} from "./_upload-store.ts";

/**
 * Build the store for one server.
 *
 * Takes a resolver for the database rather than a URL so the caller decides
 * what "has storage" means, and takes the directory unconditionally: the file
 * backend is what answers when there is no database, and a server with neither
 * would have no uploads at all, which is a worse dev experience than a
 * directory nobody asked for.
 *
 * @internal
 */
export function createUploadStore(opts: {
  db?: Db | undefined;
  dir: string;
  /** Cap for a body that names none. Defaults to `MAX_WORKFLOW_UPLOAD_BYTES`. */
  maxBytes?: number | undefined;
}): UploadStore {
  const maxBytes = opts.maxBytes ?? MAX_WORKFLOW_UPLOAD_BYTES;
  return opts.db
    ? createPostgresUploadStore(opts.db, maxBytes)
    : createFileUploadStore(opts.dir, maxBytes);
}
