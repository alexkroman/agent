// Copyright 2025 the AAI authors. MIT license.
/**
 * The subpaths `@alexkroman1/aai` actually exports, read from its own
 * `package.json`.
 *
 * A studio agent writing `import { sequential } from "@alexkroman1/aai/workflow"`
 * used to fail with rolldown's
 *
 *     "./workflow" is not exported under the conditions
 *     ["module","browser","production","import"] from package
 *     /…/node_modules/@alexkroman1/aai (see exports field in …/package.json)
 *
 * which names neither the right subpath nor any of the alternatives — it points
 * at a file the agent cannot read. So the agent has nothing to correct toward
 * and, being told to work through build errors itself, invents something else.
 * `/workflow` in particular is not a wild guess: it *was* a real subpath (the
 * pattern combinators, later `/patterns`, both since removed), so it's in
 * every model's priors and in any documentation snapshot taken before the
 * removal.
 *
 * Two consumers use this list, and both exist so no copy of it can go stale:
 * `studio-bundle.ts` turns a bad subpath into an error that names the valid
 * ones, and `studio-prompt.ts` interpolates it into the system prompt so the
 * agent doesn't have to guess at all. Hard-coding either would just move the
 * drift somewhere new — the next rename would leave the studio confidently
 * teaching a subpath that no longer resolves.
 *
 * **Resolution is by directory walk, not by `require.resolve`.** The SDK's
 * exports map declares only `@dev/source`, `types`, and `import` conditions —
 * no `require` and no `default` — so `createRequire(...).resolve()` finds no
 * matching condition and throws, and it cannot ask for `./package.json`
 * either, which the map deliberately doesn't export. Walking up for
 * `node_modules/@alexkroman1/aai/package.json` is also exactly how the
 * bundler itself resolves the package, so the list can never describe a
 * different copy than the build uses.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Bare specifier of the SDK whose exports map this module reads. */
export const SDK_PACKAGE = "@alexkroman1/aai";

const PKG_RELATIVE = path.join("node_modules", "@alexkroman1", "aai", "package.json");

/** Walk up from `from` looking for the installed SDK's package.json. */
function findSdkPackageJson(from: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, PKG_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

let cached: string[] | undefined;

/**
 * Subpaths importable from the SDK, as they appear after the package name:
 * `""` for the root entry, then `"llm"`, `"stt"`, … — sorted, with the
 * root first.
 *
 * Returns `[]` when the package.json can't be found or parsed. Callers must
 * treat an empty list as "unknown" and skip their check rather than reject:
 * this module improves diagnostics and prompt accuracy, it is not the import
 * *policy* (`ALLOWED_PACKAGES` in `studio-bundle.ts` is), so a failure to read
 * it must never turn a legal import into a build error.
 */
export function sdkSubpaths(from: string = import.meta.dirname): string[] {
  if (cached !== undefined) return cached;
  cached = readSubpaths(from);
  return cached;
}

/** Root entry first, then the named subpaths alphabetically. */
function bySubpath(a: string, b: string): number {
  if (a === "") return -1;
  if (b === "") return 1;
  return a.localeCompare(b);
}

function readSubpaths(from: string): string[] {
  const pkgPath = findSdkPackageJson(from);
  if (pkgPath === undefined) return [];
  try {
    const exports: unknown = JSON.parse(readFileSync(pkgPath, "utf8")).exports;
    if (typeof exports !== "object" || exports === null) return [];
    return Object.keys(exports)
      .filter((key) => key === "." || key.startsWith("./"))
      .map((key) => (key === "." ? "" : key.slice(2)))
      .sort(bySubpath);
  } catch {
    return [];
  }
}

/** Full specifiers the agent may import, e.g. `@alexkroman1/aai/llm`. */
export function sdkSpecifiers(from?: string): string[] {
  return sdkSubpaths(from).map((sub) => (sub === "" ? SDK_PACKAGE : `${SDK_PACKAGE}/${sub}`));
}

/**
 * Is `spec` an SDK import that resolves? `false` only for a *known-bad*
 * subpath — an unreadable exports map yields `true` so the build proceeds and
 * Vite reports whatever it finds.
 */
export function isKnownSdkSpecifier(spec: string, from?: string): boolean {
  const known = sdkSubpaths(from);
  if (known.length === 0) return true;
  if (spec === SDK_PACKAGE) return known.includes("");
  const sub = spec.startsWith(`${SDK_PACKAGE}/`) ? spec.slice(SDK_PACKAGE.length + 1) : undefined;
  return sub === undefined || known.includes(sub);
}

/** Test-only: clear the memoized exports list. */
export function _resetSdkSubpathCache(): void {
  cached = undefined;
}
