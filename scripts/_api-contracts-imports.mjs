#!/usr/bin/env node

/**
 * A rollup's imports from the WORKSPACE packages, read by declaring package
 * rather than by subpath.
 *
 * A type a rollup imports from `@alexkroman1/aai/protocol` is the same type
 * when the SDK moves it to `@alexkroman1/aai`: a name is declared once per
 * package (every public name belongs to exactly one capability of it), so the
 * subpath it is reached through is presentation. Two places used to read the
 * subpath as identity, and each cost an epoch nobody's code noticed:
 *
 * - the HASH printed the specifier, so a moved re-export moved every hash
 *   that reached it;
 * - the probe's `exportProblem` called a re-export whose source subpath moved
 *   a break ("now `@alexkroman1/aai#X`, was `@alexkroman1/aai/protocol#X`"),
 *   which is how `aai-runtime:eval` v6 was dropped with the reason "nothing
 *   about this capability's own signatures changed".
 *
 * And a PINNED rollup rotted: its `import { X } from "…/protocol"` resolves
 * against today's `dist`, which no longer exports `X` there, so the self-probe
 * failed and the fix was a hand re-pin. {@link repinImports} does that re-pin
 * in memory before every compile, from the committed `API-EXPORTS.json`, so a
 * subpath move needs nothing at all. A name that left the PACKAGE is still a
 * compile error, which is the finding.
 *
 * Third-party specifiers are left alone: `zod` and `zod/v4/core` may well
 * declare two different `ZodType`s.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { repoRoot } from "./_fs.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/** The scope every workspace package publishes under. */
const WORKSPACE_SCOPE = "@alexkroman1/";

/** `@scope/name/sub/path` → `@scope/name`; `name/sub` → `name`. */
export function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** A workspace specifier reads as its package; anything else as itself. */
export const normalizedSpecifier = (specifier) =>
  specifier.startsWith(WORKSPACE_SCOPE) ? packageOf(specifier) : specifier;

let committedExports;

/** `API-EXPORTS.json` (subpath specifier → export names), or `{}` when absent. */
function exportsBySpecifier() {
  if (committedExports === undefined) {
    const path = join(repoRoot(import.meta.url), "API-EXPORTS.json");
    committedExports = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  return committedExports;
}

/**
 * Where `name` is exported from TODAY within `specifier`'s package: the
 * specifier itself when it still exports it, else the package root, else the
 * first other subpath that does — or `undefined` when none does.
 */
export function currentSpecifier(specifier, name, exportsMap = exportsBySpecifier()) {
  if (!specifier.startsWith(WORKSPACE_SCOPE)) return specifier;
  if (exportsMap[specifier] === undefined || exportsMap[specifier].includes(name)) {
    return specifier;
  }
  const pkg = packageOf(specifier);
  if (exportsMap[pkg]?.includes(name)) return pkg;
  return Object.keys(exportsMap)
    .sort()
    .find((other) => packageOf(other) === pkg && exportsMap[other].includes(name));
}

/**
 * `body` with every named workspace import pointed at the subpath that exports
 * it today ({@link currentSpecifier}). An import whose name left the package is
 * kept as written, so it still fails to compile — loudly, where it should.
 */
export function repinImports(body, exportsMap = exportsBySpecifier()) {
  const sourceFile = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true);
  const edits = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !specifier.startsWith(WORKSPACE_SCOPE) ||
      clause === undefined ||
      clause.name !== undefined ||
      bindings === undefined ||
      !ts.isNamedImports(bindings)
    ) {
      continue;
    }
    const moved = bindings.elements.map((element) => {
      const imported = (element.propertyName ?? element.name).text;
      return { element, to: currentSpecifier(specifier, imported, exportsMap) ?? specifier };
    });
    if (moved.every(({ to }) => to === specifier)) continue;
    const typeOnly = clause.isTypeOnly ? "type " : "";
    const lines = moved.map(
      ({ element, to }) =>
        `import ${typeOnly}{ ${element.getText(sourceFile)} } from ${JSON.stringify(to)};`,
    );
    edits.push({
      start: statement.getStart(sourceFile),
      end: statement.getEnd(),
      to: lines.join("\n"),
    });
  }
  let out = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
  }
  return out;
}
