// Copyright 2025 the AAI authors. MIT license.
/**
 * Regression guard: the published bundle must not import any devDependency.
 *
 * `tsdown` is configured with `deps.neverBundle: [/^[^./]/]`, meaning every
 * bare npm specifier survives as an `import` in the built output. If a
 * devDependency (e.g. `vitest`) is reachable from any public export, the
 * production server — which only installs `dependencies` — crashes at
 * startup with `ERR_MODULE_NOT_FOUND`.
 *
 * This test reads the built `dist/` files for each public export and fails
 * if any bare import specifier is a devDependency.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf-8")) as {
  exports: Record<string, { "@dev/source"?: string; import?: string }>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

// Extract bare module specifiers from an ESM source string. Covers:
//   import ... from "x"      export ... from "x"      import("x")
const IMPORT_RE =
  /(?:\bimport\s+(?:[^"'`;]+?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\}|[\w$,\s]+)\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

function rootSpecifier(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

describe("built exports do not import devDependencies", () => {
  const entries = Object.entries(pkg.exports)
    .map(([subpath, val]) => ({ subpath, dist: val.import }))
    .filter((e): e is { subpath: string; dist: string } => typeof e.dist === "string");

  test.each(entries)("$subpath bundle has no devDependency import", ({ dist }) => {
    const file = resolve(PKG_DIR, dist);
    if (!existsSync(file)) {
      throw new Error(
        `Built artifact missing: ${file}. Run \`pnpm --filter @alexkroman1/aai build\` first.`,
      );
    }
    const src = readFileSync(file, "utf-8");
    const leaks = new Set<string>();
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec === undefined) continue;
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const root = rootSpecifier(spec);
      if (devDeps.has(root)) leaks.add(root);
    }
    expect([...leaks], `devDependency imports in ${dist}: ${[...leaks].join(", ")}`).toEqual([]);
  });
});
