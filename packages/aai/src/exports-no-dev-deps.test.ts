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

// The PACKAGE root — one up from `src/`, where `package.json` lives.
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

// Comments and their contents, blanked before the scan above runs.
const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * Strip comments, preserving newlines so any reported position still lines up.
 *
 * tsdown keeps JSDoc in the output, so a doc `@example` showing how to TEST a
 * tool — `import { expect, test } from "vitest"` — is a devDependency import as
 * far as a regex is concerned. That is a false positive by construction, and it
 * arrived the moment a published module documented its own use in a test
 * (`sdk/testing.ts`, the `./testing` subpath). Masking loses nothing real: an
 * `import` is a statement and can never live inside a comment, so anything this
 * removes was never going to be resolved at runtime.
 */
function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (match) => match.replace(/[^\n]/g, " "));
}

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

  // `entries` is derived by filtering the exports map for a string `import`
  // condition, and this package's exports deliberately change shape between
  // dev (`@dev/source` → .ts) and publish (.js). If that filter ever matched
  // nothing, `test.each` would register zero cases and the leak guarantee for
  // all ten subpaths would vanish from a green run.
  test("every published subpath is covered", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  // The masking above can only ever REMOVE candidates, so it needs its own
  // check: without one, a `stripComments` that over-matched would silence every
  // case in this file and print the same all-green as a clean bundle.
  test("the comment mask keeps real imports and drops commented ones", () => {
    const masked = stripComments(
      ['import { real } from "vitest";', '// import { commented } from "tsdown";'].join("\n"),
    );
    const found = [...masked.matchAll(IMPORT_RE)].map((m) => m[1]);
    expect(found).toEqual(["vitest"]);
  });

  test.each(entries)("$subpath bundle has no devDependency import", ({ dist }) => {
    const file = resolve(PKG_DIR, dist);
    const src = stripComments(readFileSync(file, "utf-8"));
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
