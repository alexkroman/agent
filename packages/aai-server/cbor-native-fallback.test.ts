// Copyright 2026 the AAI authors. MIT license.
/**
 * `cbor-x`'s native-accelerator guard must check the FUNCTION, not the module.
 *
 * The durable Postgres workflow world decodes its event rows with `cbor-x`
 * (`@workflow/world-postgres` → `cbor-x`), and `cbor-x`'s Node entry loads an
 * optional native string extractor. Its own guard was
 * `if (extractor) setExtractor(extractor.extractStrings)`, and `setExtractor`
 * is NOT a no-op on a bad argument: it sets `isNativeAccelerationEnabled` and
 * swaps all four string readers onto the native path unconditionally. A truthy
 * `cbor-extract` whose `extractStrings` is missing therefore installs
 * `undefined` as the extractor, throws nothing at load (the surrounding
 * `try`/`catch` only covers a failed `require`), and fails LATER — at decode
 * time, and only on the branch where the string cache misses.
 *
 * That deferred, data-dependent shape is what made it expensive: production
 * served an intermittent 503 on `POST /:slug/workflow-storage`
 * (`method: 'events.list'`, `error: 'extractStrings is not a function'`) with
 * the immediate retry succeeding — i.e. it read as a transient service
 * problem, not a hard bug. `patches/cbor-x@1.6.0.patch` and its `1.6.5` twin
 * add the `typeof … === 'function'` half so the documented "native module is
 * optional" fallback is actually fail-safe.
 *
 * This is a test rather than a note because a pnpm patch lapses SILENTLY in
 * one direction that matters: bump `cbor-x` and the `patchedDependencies` key
 * no longer matches the installed version. It reads the file that ships in
 * `node_modules`, so it fails on an unpatched tree — which is the only state
 * worth catching.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every `cbor-x` file that carries the guard, across every copy reachable from
 * this package.
 *
 * Two dimensions, and missing either one leaves the bug live:
 *
 * - **Two VERSIONS.** `@workflow/world-postgres` pins 1.6.0 and the Modal SDK
 *   pins 1.6.5, so they are separate copies with separate module state.
 * - **Two CONDITION halves.** `cbor-x`'s exports map sends `import` to
 *   `node-index.js` and `require` to `dist/node.cjs`, and the guard is written
 *   out in BOTH. The first version of this patch did only the ESM half — the
 *   half a `require.resolve` does not even reach — which is precisely the miss
 *   this function exists to keep catching.
 */
function guardFiles(): { label: string; source: string }[] {
  const require = createRequire(import.meta.url);
  const found: { label: string; source: string }[] = [];
  for (const root of ["@workflow/world-postgres", "modal"]) {
    // `package.json` is not an exported subpath on either package, so walk up
    // from the resolved entry to the directory that owns it.
    let dir = path.dirname(require.resolve(root));
    while (!existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    const cborDir = path.dirname(createRequire(path.join(dir, "package.json")).resolve("cbor-x"));
    // The resolved entry is `dist/node.cjs`; its sibling ESM entry is one up.
    for (const rel of ["node.cjs", "../node-index.js"]) {
      const file = path.resolve(cborDir, rel);
      found.push({
        label: `${root} -> ${path.basename(file)}`,
        source: readFileSync(file, "utf-8"),
      });
    }
  }
  return found;
}

describe("cbor-x native accelerator guard", () => {
  const entries = guardFiles();

  // Without this the loop below is vacuous: a rename upstream, or a package
  // that stops depending on cbor-x, would make every assertion pass by
  // checking nothing — the failure shape this repo keeps paying for.
  test("resolves both condition halves of both live cbor-x copies", () => {
    expect(entries.map((e) => e.label)).toEqual([
      "@workflow/world-postgres -> node.cjs",
      "@workflow/world-postgres -> node-index.js",
      "modal -> node.cjs",
      "modal -> node-index.js",
    ]);
  });

  test.each(entries.map((e) => [e.label, e] as const))(
    "%s checks extractStrings is callable before installing it",
    (_label, entry) => {
      expect(entry.source).toContain("typeof extractor.extractStrings === 'function'");
    },
  );

  test.each(entries.map((e) => [e.label, e] as const))(
    "%s no longer carries the bare truthy guard",
    (_label, entry) => {
      // The exact line the patch replaces. Matching it means the patch did not
      // apply — a bumped version whose `patchedDependencies` key went stale.
      expect(entry.source).not.toMatch(/if \(extractor\)\s*\n\s*setExtractor/);
    },
  );
});
