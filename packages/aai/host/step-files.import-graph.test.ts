// Copyright 2026 the AAI authors. MIT license.
/**
 * The invariant that makes `step-files.ts` a subpath of its own: `node:` is on
 * one side of the line and `@alexkroman1/aai/step` is on the other.
 *
 * `@alexkroman1/aai/step` is an `sdk/` barrel, and `sdk/` is the half of this
 * package that must stay runnable in a browser and in Deno — `sdk/tsconfig.json`
 * compiles with `types: []` so a `node:` import there is a compile error rather
 * than a convention. What that catches is the direct import; what it does not
 * catch is the boundary being crossed at one remove, through `host/`.
 *
 * The same trap already forced `classifyFfmpeg` out of two templates' `ingest.ts`
 * into a `ffmpeg-verdict.ts` of its own; that file's module doc is the clearest
 * statement of it in this repo. Nothing mechanical was watching the SDK's own
 * half, which is what this file is.
 *
 * It walks the RELATIVE import graph from each barrel's source and reports the
 * builtin specifiers it reaches. Cheap — a few dozen small files, no bundler —
 * and it is a real graph walk rather than a grep of one file, because the way
 * this regresses is a `node:` import three modules down from a name somebody
 * added to a barrel.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** Code-unit order, never `localeCompare`: the repo's rule for anything asserted on. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");

/** `import ... from "x"`, `export ... from "x"`, `import("x")` — same shape `exports-no-dev-deps.test.ts` scans with. */
const IMPORT_RE =
  /(?:\bimport\s+(?:[^"'`;]+?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\}|[\w$,\s]+)\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

/** Comments, blanked first: a module doc that NAMES `node:fs` is prose, not an import. */
const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf-8").replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, " "));
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? "");
}

/**
 * Every `node:` specifier reachable from `entry` through RELATIVE imports.
 *
 * Bare npm specifiers are not followed: what a dependency does inside itself is
 * its own business and is bundled by the same rules, so following them would
 * turn a graph assertion into an audit of node_modules. A dependency that
 * genuinely broke this would break it for every subpath at once, which is a
 * different finding than the one guarded here.
 */
function builtinsReachableFrom(entry: string): { builtins: Set<string>; visited: Set<string> } {
  const builtins = new Set<string>();
  const visited = new Set<string>();
  const queue = [resolve(PKG, entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of specifiers(file)) {
      if (spec.startsWith("node:")) builtins.add(spec);
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec));
    }
  }
  return { builtins, visited };
}

describe("the /step barrel's graph", () => {
  test("reaches no node: builtin, so a browser or Deno bundle can hold it", () => {
    const { builtins, visited } = builtinsReachableFrom("sdk/step-barrel.ts");
    // A floor on the corpus, for the reason every counting gate in this repo has
    // one: a resolver that stopped following relative imports would visit one
    // file, find nothing, and print the healthiest possible result.
    expect(visited.size).toBeGreaterThan(15);
    expect([...builtins].sort(byCodeUnit)).toEqual([]);
  });

  test("does not reach step-files.ts, by any route", () => {
    const { visited } = builtinsReachableFrom("sdk/step-barrel.ts");
    const stepFiles = resolve(PKG, "host/step-files.ts");
    expect(visited.has(stepFiles)).toBe(false);
    // And the boundary is the whole `host/` directory, not one file: `sdk/` may
    // not import `host/` at all, which is what keeps the answer above stable
    // when a name is added to the barrel.
    const intoHost = [...visited].filter((f) => relative(PKG, f).startsWith("host/"));
    expect(intoHost).toEqual([]);
  });
});

describe("step-files.ts itself", () => {
  test("is a node module, which is exactly why it is not on /step", () => {
    const { builtins } = builtinsReachableFrom("host/step-files.ts");
    // Named rather than merely counted: the assertion is about WHICH builtins,
    // since these three are the reason this lives in `host/` behind its own subpath.
    expect([...builtins].sort(byCodeUnit)).toEqual(["node:fs/promises", "node:os", "node:path"]);
  });

  test("imports the modules it needs directly rather than through the barrel", () => {
    // Narrower on purpose: importing `step-barrel.ts` would drag the transcribe,
    // speech and gateway graphs into every bundle that names one of these three
    // functions, for a handful of named imports. `format.ts` and `is-record.ts`
    // are both leaves with no imports of their own — the whole reason the
    // out-of-space message can name a byte count from here.
    const direct = specifiers(join(PKG, "host/step-files.ts")).filter((s) => s.startsWith("."));
    expect(direct.sort(byCodeUnit)).toEqual([
      "../sdk/format.ts",
      "../sdk/is-record.ts",
      // The fan-out `readUploadToFile` reads its windows with. Another leaf: it
      // imports nothing at all, which is what lets a bounded map live in `sdk/`
      // and be reached from here without widening this graph by one module.
      "../sdk/map-concurrent.ts",
      // The completeness gate, whose own graph is `step-uploads.ts` and nothing
      // else — so it costs this module no new leaf.
      "../sdk/step-uploads-complete.ts",
      "../sdk/step-uploads-write.ts",
      "../sdk/step-uploads.ts",
    ]);
  });

  test("is published, and at the path its doc and the templates name", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports["./step-files"]).toEqual({
      "@dev/source": "./host/step-files.ts",
      types: "./dist/host/step-files.d.ts",
      import: "./dist/host/step-files.js",
    });
  });
});
