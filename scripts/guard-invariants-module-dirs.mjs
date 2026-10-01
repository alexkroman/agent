/**
 * Rule 37: a module DIRECTORY is entered through its `index.ts` only.
 *
 * aai-ui's session core, audio layer and upload machinery used to be prefix
 * families at the top of `src/` (`session-core-dial.ts`, `audio-preconnect.ts`,
 * `_upload-recall.ts`, …), split along seams to stay under the 500-line cap.
 * A prefix is a directory with no boundary: any module in the package could
 * reach any file of the family, so "private to the session core" was a naming
 * habit. Folded into `session/`, `audio/` and `upload/`, each directory's
 * `index.ts` is the one import surface, and private means "not re-exported
 * there" — which only holds if nothing outside the directory imports a
 * sibling of the index directly. That is what this checks.
 *
 * aai-runtime's prefix families (`pipeline-*`, `session-*`, `runtime-*`,
 * `_upload-*`, `mcp-*`, `platform-*`, …) were folded the same way, into
 * `transports/pipeline/` and its stage directories, `session/`, `runtime/`,
 * `server/`, `tools/`, `uploads/` and the rest.
 *
 * A directory OPTS IN by holding an `index.ts` under one of
 * {@link MODULE_DIR_ROOTS}, at ANY depth (a pathspec `*` crosses `/`, so
 * `transports/pipeline/llm/` counts as well as `session/`); a new directory is
 * covered on arrival and needs no edit here. When module directories nest, an
 * importer outside the outer one may name only the OUTER index, which is what
 * keeps `transports/pipeline/llm/index.ts` the pipeline's business. Files INSIDE the directory (at any depth) may import each other
 * freely; the question is asked of every importer outside it, specs and test
 * helpers included — a spec that needs a private module belongs in the
 * directory beside it.
 *
 * Like rule 13 this RESOLVES the specifier rather than matching its text,
 * because `./session/dial.ts` from `src/` and `../session/dial.ts` from
 * `src/components/` are the same violation, and `./dial.ts` from inside
 * `session/` is none.
 */

import { git } from "./_ratchet.mjs";
import { readRepoFile, resolveAgainstFile } from "./guard-invariants-scanners.mjs";

/** The roots whose child directories may be module directories. */
export const MODULE_DIR_ROOTS = ["packages/aai-ui/src", "packages/aai-runtime/src"];

/** Files that can hold an import: every TypeScript and JavaScript module. */
const IMPORTER = /\.(?:m?[jt]s|tsx)$/;

/**
 * A relative specifier in an import position: `from "…"`, `import "…"`,
 * `import("…")`, and vitest's `vi.mock("…")` / `vi.doMock("…")` /
 * `vi.importActual("…")`, which name a module exactly as an import does.
 */
const SPECIFIER =
  /(?:\bfrom|\bimport|\bmock|\bdoMock|\bimportActual)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

/**
 * The index AND untracked-but-not-ignored files, so a directory (or an
 * importer) created in the working tree is checked before it is staged.
 */
const TRACKED_AND_NEW = ["--cached", "--others", "--exclude-standard"];

/** A line whose first non-blank characters open or continue a comment. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * The module directories: every `<root>/<dir>/` holding an `index.ts`.
 *
 * @returns {string[]} repo-relative directory paths, no trailing slash
 */
export function moduleDirs() {
  const pathspecs = MODULE_DIR_ROOTS.map((root) => `${root}/*/index.ts`);
  return git(["ls-files", ...TRACKED_AND_NEW, "--", ...pathspecs], { allowNoMatch: true })
    .split("\n")
    .filter(Boolean)
    .map((file) => file.slice(0, -"/index.ts".length));
}

/**
 * The pure half: does `specifier`, imported from `file`, reach PAST a module
 * directory's index?
 *
 * @param {string} file - repo-relative path of the importing file
 * @param {string} specifier - the relative specifier it imports
 * @param {string[]} dirs - the module directories ({@link moduleDirs})
 * @returns {string | undefined} the directory entered illegally, if any
 */
export function deepModuleImport(file, specifier, dirs) {
  const target = resolveAgainstFile(file, specifier);
  for (const dir of dirs) {
    if (file.startsWith(`${dir}/`)) continue;
    // The directory itself (`./session`) is not its index either: this repo
    // imports by file, with the extension, and a bare directory resolves under
    // a bundler and in nothing that reads `exports`-style ESM.
    if (target === dir) return dir;
    if (target.startsWith(`${dir}/`) && target !== `${dir}/index.ts`) return dir;
  }
}

export function scanDeepModuleImports() {
  const dirs = moduleDirs();
  // An empty list is the vacuous pass: every import would be "legal" because
  // there is no directory to enter, and the gate would print its checkmark.
  if (dirs.length === 0) {
    throw new Error(`rule 37: no module directory under ${MODULE_DIR_ROOTS.join(", ")}`);
  }
  const roots = MODULE_DIR_ROOTS.map((root) => root.split("/").slice(0, 2).join("/"));
  const files = git(["ls-files", ...TRACKED_AND_NEW, "--", ...roots])
    .split("\n")
    .filter((f) => IMPORTER.test(f));
  const found = [];
  for (const file of files) {
    const source = readRepoFile(file);
    if (source === undefined) continue;
    source.split("\n").forEach((text, index) => {
      if (COMMENT_LINE.test(text)) return;
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const dir = deepModuleImport(file, specifier, dirs);
        if (dir !== undefined) found.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}
