// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/step-files` — moving bytes between the upload store and a local FILE.
 *
 * A FACADE. The subpath resolves here rather than at `step-files.ts`, which buys two
 * things the direct form could not. That module can be SPLIT as it grows without
 * moving the published entry point — the path an implementation file happens to
 * have is not a thing to promise anyone — and a name it gains next reaches the
 * public surface only when a line is added below, rather than the moment it is
 * written.
 *
 * Named re-exports rather than `export *` for the second half of that: the
 * wildcard form re-exports whatever arrives, and needs a `noReExportAll`
 * suppression the escape-hatch ratchet only lets move down.
 *
 * @module step-files
 */

export {
  type ReadUploadToFileOptions,
  readUploadToFile,
  STEP_FILE_READ_CONCURRENCY,
  STEP_FILE_WINDOW_BYTES,
  type WithTempDirOptions,
  type WriteUploadFromFileOptions,
  withTempDir,
  writeUploadFromFile,
} from "./step-files.ts";
