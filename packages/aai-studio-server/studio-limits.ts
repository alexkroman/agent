// Copyright 2026 the AAI authors. MIT license.
/**
 * Workspace size limits, in their own dependency-free module.
 *
 * Split from `studio-schemas.ts` (which re-exports them) so the scan
 * worker's import graph stays free of zod and the server packages: the
 * worker entry (`studio-scan-worker.ts`) is loaded by a bare `node`
 * worker thread — in dev straight from `.ts` source under type
 * stripping — where every transitive import is a load-time liability.
 */

/** Max files per studio project workspace. */
export const MAX_STUDIO_FILES = 30;
/** Max bytes for a single workspace file. */
export const MAX_STUDIO_FILE_BYTES = 256_000;
