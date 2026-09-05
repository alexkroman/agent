// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai-server/test-utils` — the fakes and fixtures a spec on the other side of this boundary builds on.
 *
 * A CAPABILITY entry, not a module. This package used to publish one subpath per
 * module — thirty-five of them, every one imported by `aai-studio-server` and by
 * nothing else — which is a file listing rather than a boundary: it named what
 * happened to be in the directory, so it said nothing about what the other side
 * may depend on, and a bare `aai-server` specifier appeared nowhere, which is why
 * a konsistent rule naming it matched no files at all.
 *
 * Grouping by what a caller is trying to DO makes the boundary reviewable and
 * gives the dependency rule something to name. It costs nothing at runtime:
 * `aai-studio-server` compiles this package into its single `dist/index.mjs`
 * (see its `tsdown.config.ts`), so a barrel is tree-shaken rather than evaluated.
 *
 * **A name is here because `aai-studio-server` imports it, and for no other
 * reason** — the rule `aai-runtime/internal` states for the same kind of seam.
 * Re-exporting each member module wholesale would have put 240 names on this
 * boundary where 101 actually cross it; knip reports the difference, which is
 * how that draft was caught. Adding a member module here is therefore not
 * automatic: name what the other side needs.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression and the escape-hatch ratchet only moves down.
 *
 * @module test-utils
 */

export { ensurePlatformTables } from "./platform-schema-test-utils.ts";
export {
  authFetch,
  authHeaders,
  captureLogs,
  createRecordingSql,
  createTestOrchestrator,
  createTestStore,
  deployAgent,
  describeWithStack,
  pgUrl,
  type TestFetch,
} from "./test-utils.ts";
