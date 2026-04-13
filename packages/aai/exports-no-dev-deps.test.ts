// Copyright 2025 the AAI authors. MIT license.
/**
 * Regression guard: public package exports must not (transitively) import any
 * devDependency. If they do, the published package will fail at runtime in any
 * environment where dev deps are not installed (e.g. the deployed platform
 * server).
 *
 * Concretely, this caught a regression where `host/runtime-barrel.ts`
 * re-exported `host/_runtime-conformance.ts`, which `import`s `vitest`. After
 * `pnpm build`, the bundled `dist/host/runtime-barrel.js` retained the bare
 * `import "vitest"` (because `tsdown` is configured with
 * `deps.neverBundle: [/^[^./]/]`), and starting the production server crashed
 * with `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf-8")) as {
  exports: Record<string, { "@dev/source"?: string }>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

// Match ESM `import ... from "x"` and dynamic `import("x")` and re-exports.
// We only need the bare module specifier, so we capture the quoted string.
const IMPORT_SPECIFIER_RE =
  /(?:\bimport\s+(?:[^"'`;]+?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

function stripComments(src: string): string {
  // Drop /* ... */ and // ... so JSDoc examples don't masquerade as imports.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function collectImports(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf-8"));
  const out: string[] = [];
  for (const match of src.matchAll(IMPORT_SPECIFIER_RE)) {
    out.push(match[1]);
  }
  return out;
}

function resolveRelative(from: string, spec: string): string {
  // Only relative imports refer to in-package files we need to walk.
  return resolve(dirname(from), spec);
}

/** Walk all transitively-imported in-repo source files from `entry`. */
function walk(entry: string): { files: Set<string>; bareSpecifiers: Set<string> } {
  const files = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of collectImports(file)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        // In this codebase, intra-package relative imports always include
        // the explicit `.ts` extension, so resolution is straightforward.
        const next = resolveRelative(file, spec);
        stack.push(next);
      } else if (!spec.startsWith("node:")) {
        // `node:` builtins are always available; ignore them.
        bareSpecifiers.add(spec);
      }
    }
  }
  return { files, bareSpecifiers };
}

describe("public exports do not import devDependencies", () => {
  const entries = Object.entries(pkg.exports)
    .filter(([, val]) => typeof val["@dev/source"] === "string")
    .map(([subpath, val]) => ({
      subpath,
      file: resolve(PKG_DIR, val["@dev/source"] as string),
    }));

  test.each(entries)("$subpath has no transitive devDependency import", ({ file }) => {
    const { bareSpecifiers } = walk(file);
    const leaks = [...bareSpecifiers].filter((s) => {
      // Strip subpath, e.g. "vitest/config" -> "vitest", "@scope/x/y" -> "@scope/x".
      const root = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
      return devDeps.has(root);
    });
    expect(leaks, `unexpected devDependency imports: ${leaks.join(", ")}`).toEqual([]);
  });
});
