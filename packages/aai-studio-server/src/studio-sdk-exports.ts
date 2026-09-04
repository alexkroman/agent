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
 * ONE consumer uses this list: `studio-preamble.ts` interpolates it into the
 * coding agent's system prompt, so the agent does not have to guess at all.
 * (This paragraph used to claim two, the second being the deleted
 * `studio-bundle.ts` import allowlist — a reason-to-exist describing a caller
 * that no longer exists is worse than none, since the next reader either
 * trusts it or re-derives the answer by grep.) The list is READ rather than
 * hard-coded because hard-coding would just move the drift somewhere new: the
 * next rename would leave the studio confidently teaching a subpath that no
 * longer resolves.
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
import { safeJsonParse } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";

/**
 * Bare specifier of the SDK whose exports map this module reads.
 *
 * Exported as a TEST SEAM — `sdkSpecifiers` is the only thing production
 * calls, and its spec builds expectations out of this and `sdkSubpaths`.
 */
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
 * *policy*, so a failure to read
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
    // `safeJsonParse` + `isRecord` rather than a bare parse and a field read
    // off `any`: the read is inside a `try` for the FILE (a race with an
    // install, a permission), and malformed JSON is a different answer from an
    // unreadable file only in that the guard has to state it.
    const manifest = safeJsonParse(readFileSync(pkgPath, "utf8"));
    const exports = isRecord(manifest) ? manifest.exports : undefined;
    if (!isRecord(exports)) return [];
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

/** Test-only: clear the memoized exports list. */
export function _resetSdkSubpathCache(): void {
  cached = undefined;
}
