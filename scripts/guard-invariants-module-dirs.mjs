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
 * `session/` is none. konsistent's `*-module-dir-entered-through-index`
 * conventions state the same boundary textually, one block per directory, and
 * `konsistent-config.test.ts` derives those blocks from the tree.
 */

import { git } from "./_ratchet.mjs";
import { resolveAgainstFile, scanRelativeImports } from "./guard-invariants-scanners.mjs";

/** The roots whose child directories may be module directories. */
export const MODULE_DIR_ROOTS = ["packages/aai-ui/src", "packages/aai-runtime/src"];

/**
 * The index AND untracked-but-not-ignored files, so a directory (or an
 * importer) created in the working tree is checked before it is staged.
 */
const TRACKED_AND_NEW = ["--cached", "--others", "--exclude-standard"];

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
  return scanRelativeImports({
    pathspecs: roots,
    offends: (file, specifier) => deepModuleImport(file, specifier, dirs),
  });
}

/**
 * Rule 38: a pipeline STAGE imports only the stages the table lets it, and
 * never the assembly.
 *
 * The pipeline transport is split into stage directories under
 * {@link PIPELINE}; the files directly beside its `index.ts` (`transport.ts`,
 * `commands.ts`, `lifecycle.ts`, …) are the ASSEMBLY, which imports every
 * stage. The stage directions together are one DAG — turn, heard and knobs at
 * the bottom; output; history; reply; llm; speech; the assembly on top — and
 * Biome's `noImportCycles` cannot hold it on its own: it sees a FILE cycle
 * only once one closes, while a stage reaching "down the wrong way" through an
 * index is legal until the day the far side imports back, which is how a
 * barrel turns one new import into a cycle across a dozen files.
 *
 * "Not the assembly" is a PATH rule (any file directly under {@link PIPELINE}),
 * so a new assembly file is covered on arrival. Specs are excluded because a
 * stage's spec legitimately drives the whole assembled transport. Rule 37 is
 * the index-only half; the map is `transports/pipeline/CLAUDE.md`.
 */
export const PIPELINE = "packages/aai-runtime/src/transports/pipeline";

/**
 * Each stage directory under {@link PIPELINE}, and the stages it may import.
 *
 * @type {Record<string, string[]>}
 */
export const PIPELINE_STAGES = {
  turn: [],
  heard: [],
  knobs: [],
  output: ["heard", "turn"],
  history: ["heard", "output", "turn"],
  reply: ["heard", "history", "turn"],
  llm: ["history", "output", "reply", "turn"],
  speech: ["heard", "history", "llm"],
};

const SPEC = /\.test\.tsx?$/;

/**
 * The pure half: is `specifier`, imported from `file`, a wrong-way edge?
 *
 * @param {string} file - repo-relative path of the importing file
 * @param {string} specifier - the relative specifier it imports
 * @returns {string | undefined} what it reached: a `<stage>/`, or the assembly
 */
export function wrongWayStageImport(file, specifier) {
  if (!file.startsWith(`${PIPELINE}/`) || SPEC.test(file)) return;
  const [stage, ...inside] = file.slice(PIPELINE.length + 1).split("/");
  const allowed = inside.length > 0 && stage !== undefined ? PIPELINE_STAGES[stage] : undefined;
  if (allowed === undefined) return;
  const target = resolveAgainstFile(file, specifier);
  if (!target.startsWith(`${PIPELINE}/`)) return;
  const [reached, ...below] = target.slice(PIPELINE.length + 1).split("/");
  if (reached === undefined || reached === stage) return;
  if (Object.hasOwn(PIPELINE_STAGES, reached)) {
    return allowed.includes(reached) ? undefined : `${reached}/`;
  }
  if (below.length === 0) return `the assembly (${reached})`;
}

export function scanWrongWayStageImports() {
  // A stage directory missing from the table would go unchecked, and a table
  // entry with no directory is a rule describing nothing.
  const stages = moduleDirs()
    .filter((dir) => dir.startsWith(`${PIPELINE}/`))
    .map((dir) => dir.slice(PIPELINE.length + 1))
    .sort();
  const declared = Object.keys(PIPELINE_STAGES).sort();
  if (stages.join() !== declared.join()) {
    throw new Error(
      `rule 38: the stage directories under ${PIPELINE} are [${stages.join(", ")}] ` +
        `but PIPELINE_STAGES declares [${declared.join(", ")}]; update the table`,
    );
  }
  return scanRelativeImports({
    pathspecs: declared.map((stage) => `${PIPELINE}/${stage}`),
    offends: wrongWayStageImport,
  });
}
