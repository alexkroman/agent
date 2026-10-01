// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai-server/test-utils` — the fakes and fixtures a spec on the other side of
 * this boundary (`aai-studio-server`) builds on.
 *
 * The SUBPATH keeps the un-underscored `test-utils` name because it is a
 * cross-package export; the modules behind it are `_*-test-utils.ts`, private
 * to this package. A name is here because `aai-studio-server` imports it, and
 * for no other reason (knip reports an unused one). Named re-exports rather
 * than `export *`, which would need a `noReExportAll` suppression.
 *
 * @module test-utils
 */

export { captureLogs } from "./_logger-test-utils.ts";
export {
  createTestOrchestrator,
  createTestStore,
  type TestFetch,
} from "./_orchestrator-test-utils.ts";
export { describeWithStack, pgUrl } from "./_pg-test-utils.ts";
export { authFetch, authHeaders, deployAgent } from "./_request-test-utils.ts";
export { createRecordingSql } from "./_sql-test-utils.ts";
export { ensurePlatformTables } from "./platform/_schema-test-utils.ts";
export { conformanceLike, noParent, uniqueKeys } from "./store-conformance.ts";
