// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai-server` is the agent service PLUS the shared platform core, and the
 * `exports` map in its package.json is the only statement of where that line
 * falls. This suite keeps the statement true in both directions.
 *
 * It exists because the map used to be `"./*": "./*.ts"` — every one of the
 * package's 70-odd modules, published to the sibling service. The guide called
 * `internals-barrel.ts` "the sanctioned path" and described a shared core, but
 * nothing in the code distinguished core from the agent service's own
 * internals: `aai-studio-server` reached into 31 modules and no import could
 * be called a boundary violation, because there was no boundary. Enumerating
 * the subpaths makes widening the surface a deliberate edit to package.json
 * rather than a side effect of typing an import path.
 *
 * Both failure directions are quiet without a check:
 *
 * - An entry for a module nobody imports accretes: the surface documents a
 *   coupling that no longer exists, and the next reader treats it as load
 *   bearing.
 * - A missing entry is a resolution error at build time rather than a silent
 *   wrong answer — but under the repo's `@dev/source`-resolved TypeScript it
 *   can hide until the package is built, so catching it in the ordinary test
 *   run is worth the few lines.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");

/** Subpaths declared in the exports map (the root `.` entry excluded). */
function declaredSubpaths(): Set<string> {
  return new Set(declaredTargets().keys());
}

/**
 * Each published subpath and the file it names, read off the manifest.
 *
 * Read rather than DERIVED: a subpath's target is `src/<capability>-barrel.ts`
 * now, and a test that reconstructs a path from the subpath name is asserting
 * about its own guess. It did — the rule was `src/<subpath>.ts`, which quietly
 * kept passing for three of the seven capabilities because a same-named module
 * happened to exist beside the barrel.
 */
function declaredTargets(): Map<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
    exports: Record<string, string | Record<string, string>>;
  };
  const out = new Map<string, string>();
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key === "." || key === "./package.json") continue;
    const file = typeof target === "string" ? target : target["@dev/source"];
    if (file === undefined) continue;
    out.set(key.replace(/^\.\//, ""), file.replace(/^\.\//, ""));
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Every `aai-server/<subpath>` any other package imports. */
function importedSubpaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const pkg of readdirSync(path.join(repoRoot, "packages"))) {
    if (pkg === "aai-server") continue;
    const dir = path.join(repoRoot, "packages", pkg);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(/(?:from|import\()\s*"aai-server\/([a-z0-9-]+)"/g)) {
        const subpath = match[1] as string;
        found.set(subpath, [...(found.get(subpath) ?? []), path.relative(repoRoot, file)]);
      }
    }
  }
  return found;
}

describe("the aai-server cross-package surface is declared", () => {
  test("every subpath a sibling imports is exported", () => {
    const declared = declaredSubpaths();
    const undeclared = [...importedSubpaths()]
      .filter(([subpath]) => !declared.has(subpath))
      .map(([subpath, files]) => `${subpath} (imported by ${files.join(", ")})`);
    expect(undeclared).toEqual([]);
  });

  test("every exported subpath resolves to a real module", () => {
    const missing = [...declaredTargets()]
      .filter(([, file]) => !existsSyncSafe(path.join(packageDir, file)))
      .map(([subpath, file]) => `${subpath} -> ${file}`);
    expect(missing).toEqual([]);
  });

  test("every exported subpath is a capability barrel, not a module", () => {
    // The reason the surface is seven entries and not thirty-five: a subpath
    // per module names what is in the directory, which is a file listing
    // rather than a boundary. Pinning the SHAPE is what stops the next
    // shared module from arriving as a thirty-sixth entry.
    const notBarrels = [...declaredTargets()]
      .filter(([, file]) => !file.endsWith("-barrel.ts"))
      .map(([subpath, file]) => `${subpath} -> ${file}`);
    expect(notBarrels).toEqual([]);
  });

  test("no exported subpath is unimported — the surface only widens deliberately", () => {
    // A stale entry is the direction that never fails a build, so it is the
    // one worth asserting. Ratchet DOWN when a coupling goes away.
    const imported = importedSubpaths();
    const unused = [...declaredSubpaths()].filter((subpath) => !imported.has(subpath));
    expect(unused).toEqual([]);
  });

  test("no `_`-internal module is exported directly", () => {
    // Biome's noPrivateImports blocks the import side; this blocks the
    // publish side, so internals-barrel.ts stays the one sanctioned path.
    expect([...declaredSubpaths()].filter((subpath) => subpath.startsWith("_"))).toEqual([]);
  });
});

function existsSyncSafe(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
