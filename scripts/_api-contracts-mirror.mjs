#!/usr/bin/env node

/**
 * MIRROR capabilities: a capability whose entry point only re-exports another
 * package's capability, declared in the contract table as
 * `"<capability>": { "mirrors": "<pkg>:<capability>" }`.
 *
 * `aai-runtime:testing-stubs` (94 names) and `aai-runtime:eval-stubs` (22)
 * are `import { X } from "@alexkroman1/aai/testing"; export { X }` and nothing
 * else — the testing doors carrying the SDK's helpers as the SAME
 * declarations. Epoched in their own right, every change to `aai:testing`
 * moved three hashes, and one SDK removal minted three epochs (99400e372),
 * two of them recording a decision somebody had already made upstream. So a
 * mirror carries no hash, epoch, rollup or frozen example. It is checked only
 * for what it can get wrong on its own:
 *
 * - it is PURE: its rollup declares nothing and re-exports every name from the
 *   upstream package (anything else is a surface of its own, which needs an
 *   epoch — make it an ordinary capability);
 * - every name it carries is in the upstream capability today, so the
 *   upstream epoch governs each one's shape;
 * - it does not DROP a name upstream still exports (measured against the
 *   merge-base's entry point): that breaks an importer of the door while the
 *   upstream epoch says nothing changed, so it is refused rather than recorded
 *   — keep re-exporting it, or turn the capability back into an epoched one.
 *
 * The functions here are pure (text and name sets in, findings out);
 * `_api-contracts-staleness.mjs` reads the tree and git around them.
 */

import { createRequire } from "node:module";

import { packageOf } from "./_api-contracts-imports.mjs";
import { compareNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/** `"aai:testing"` → `{ key: "aai", capability: "testing" }`, or `undefined`. */
export function parseMirrorTarget(target) {
  const [, key, capability] = /^([a-z0-9-]+):([a-z0-9-]+)$/.exec(target ?? "") ?? [];
  return key === undefined || capability === undefined ? undefined : { key, capability };
}

/** The names an entry point's text selects (`export { a, type B } from "…"`). */
export function entrypointNames(text) {
  const sourceFile = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}

/** A mirror's rollup as what it imports (name → module), declares, and re-exports. */
function readRollup(body) {
  const sourceFile = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true);
  const importedFrom = new Map();
  const declared = [];
  const exported = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      for (const name of namedImports(statement)) {
        importedFrom.set(name, statement.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(statement)) {
      for (const element of statement.exportClause?.elements ?? []) {
        exported.add((element.propertyName ?? element.name).text);
      }
    } else {
      declared.push(statement.getText(sourceFile).split("\n")[0]);
    }
  }
  return { importedFrom, declared, exported };
}

/** The local names one import declaration binds by name. */
function namedImports(statement) {
  const bindings = statement.importClause?.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings)
    ? bindings.elements.map((element) => element.name.text)
    : [];
}

/**
 * Everything wrong with one mirror, as messages.
 *
 * @param {{
 *   id: string,
 *   target: string,
 *   body: string,
 *   upstreamPackage: string,
 *   upstreamNames: Set<string>,
 *   baseNames?: Set<string>,
 * }} input `body` is the mirror's generated rollup; `upstreamNames` the
 *   upstream capability's entry-point names today; `baseNames` the mirror's
 *   own at the merge-base (absent without one).
 */
export function mirrorProblems({ id, target, body, upstreamPackage, upstreamNames, baseNames }) {
  const { importedFrom, declared, exported } = readRollup(body);
  const problems = [];
  if (declared.length > 0) {
    problems.push(
      `${id} mirrors ${target} but its rollup DECLARES ${declared.length} thing(s) of its own ` +
        `(first: \`${declared[0]}\`). A mirror only re-exports; a surface of its own needs an ` +
        "epoch — make it an ordinary capability (a contract-table entry with `current`).",
    );
  }
  const foreign = [...exported]
    .filter((name) => {
      const module = importedFrom.get(name);
      return module === undefined || packageOf(module) !== upstreamPackage;
    })
    .sort(compareNames);
  if (foreign.length > 0) {
    problems.push(
      `${id} mirrors ${target} but re-exports ${foreign.join(", ")} from somewhere other than ` +
        `${upstreamPackage}. Every name a mirror carries must be the upstream declaration.`,
    );
  }
  const unknown = [...exported].filter((name) => !upstreamNames.has(name)).sort(compareNames);
  if (unknown.length > 0) {
    problems.push(
      `${id} carries ${unknown.join(", ")}, which ${target} does not contract today. Add it ` +
        `to ${target}'s entry point first (its epoch governs the shape), or stop re-exporting it.`,
    );
  }
  const dropped = [...(baseNames ?? [])]
    .filter((name) => !exported.has(name) && upstreamNames.has(name))
    .sort(compareNames);
  if (dropped.length > 0) {
    problems.push(
      `${id} no longer carries ${dropped.join(", ")}, which ${target} still exports. That ` +
        "breaks an importer of this door while the upstream epoch records nothing. Keep " +
        "re-exporting it — or make this an ordinary epoched capability and `--bump --drop` it.",
    );
  }
  return problems;
}
