// Copyright 2025 the AAI authors. MIT license.
/**
 * Regression guard: the published bundle must not import any devDependency
 * that isn't also a (peer) dependency.
 *
 * `tsdown` is configured with `deps.neverBundle: [/^[^./]/]`, meaning every
 * bare npm specifier survives as an `import` in the built output. If a
 * pure devDependency (e.g. `vitest`) is reachable from any public export,
 * the production server — which only installs `dependencies` +
 * `peerDependencies` — crashes at startup with `ERR_MODULE_NOT_FOUND`.
 *
 * Optional peer dependencies (e.g. `ai`, `assemblyai`,
 * `@cartesia/cartesia-js`) are legitimately listed in both
 * `devDependencies` (so our own tests resolve them) and
 * `peerDependencies` (so consumers supply their own pin). Those are
 * allowed — only specifiers that are `devDependencies`-only count as
 * leaks.
 *
 * This test reads the built `dist/` files for each public export and fails
 * if any bare import specifier is exclusively a devDependency.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf-8")) as {
  exports: Record<string, { "@dev/source"?: string; import?: string }>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const peerDeps = new Set(Object.keys(pkg.peerDependencies ?? {}));
// "leak" means: listed in devDependencies but NOT also a peer dep. Pure
// devDeps (like `vitest`, `tsdown`) are leaks; optional peer SDKs that
// happen to double as a devDep for our own tests are not.
const devDeps = new Set(
  Object.keys(pkg.devDependencies ?? {}).filter((name) => !peerDeps.has(name)),
);

// Extract bare module specifiers from an ESM source string. Covers:
//   import ... from "x"      export ... from "x"      import("x")
const IMPORT_RE =
  /(?:\bimport\s+(?:[^"'`;]+?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\}|[\w$,\s]+)\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

function rootSpecifier(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

describe("built exports do not import devDependency-only packages", () => {
  const entries = Object.entries(pkg.exports)
    .map(([subpath, val]) => ({ subpath, dist: val.import }))
    .filter((e): e is { subpath: string; dist: string } => typeof e.dist === "string");

  // Self-heal so this test works from a clean checkout without a manual
  // build step — otherwise `pnpm test` on a fresh worktree fails opaquely.
  beforeAll(() => {
    const missing = entries.some(({ dist }) => !existsSync(resolve(PKG_DIR, dist)));
    if (missing) {
      execFileSync("pnpm", ["--filter", "@alexkroman1/aai", "build"], {
        cwd: resolve(PKG_DIR, "../.."),
        stdio: "inherit",
      });
    }
  }, 60_000);

  test.each(entries)("$subpath bundle has no devDependency import", ({ dist }) => {
    const file = resolve(PKG_DIR, dist);
    const src = readFileSync(file, "utf-8");
    const leaks = new Set<string>();
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec === undefined) continue;
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const root = rootSpecifier(spec);
      if (devDeps.has(root)) leaks.add(root);
    }
    expect([...leaks], `devDependency-only imports in ${dist}: ${[...leaks].join(", ")}`).toEqual(
      [],
    );
  });
});
