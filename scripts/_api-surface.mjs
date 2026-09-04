#!/usr/bin/env node

/**
 * Reading an API Extractor report as data.
 *
 * Shared by `api-report.mjs` (which commits the per-entry-point reports, the
 * combined `API.md`, and the export-name lists) and `api-contracts.mjs` (which
 * hashes a capability's report into an epoch). Both need the same two
 * questions answered about a report — what is inside its ```ts fence, and which
 * names it EXPORTS — and a second copy of either answer is a second thing to
 * keep in step.
 *
 * It parses rather than greps, and the reason is `includeForgottenExports`: a
 * forgotten type appears in the report as a bare `declare interface Foo`, with
 * no `export` keyword, sitting at the same indentation as everything else. A
 * line-based scan for `interface ` cannot tell the two apart, so the export
 * list would silently absorb every internal type a public signature happens to
 * mention — which is the opposite of what that list is for.
 *
 * TypeScript comes out of api-extractor's own dependency tree for the reason
 * its header gives: this repo is on `typescript@7`, whose native compiler does
 * not expose the JS compiler API, and api-extractor bundles a compatible one.
 */

import { createRequire } from "node:module";

import { compareNames } from "./_fs.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/**
 * The `.d.ts` rollup inside a report's single ```ts fence.
 *
 * A missing fence THROWS rather than yielding an empty string. Every consumer
 * here compares one derived artifact against another — a combined file against
 * a freshly built combined file, a hash against a committed hash — so an empty
 * body agrees with an empty body and the gate reports success while checking
 * nothing. That failure shape has been paid for repeatedly in this repo; it is
 * cheaper to refuse to parse.
 */
export function reportSource(report, label = "an API report") {
  const lines = report.replaceAll("\r\n", "\n").split("\n");
  const open = lines.indexOf("```ts");
  const close = lines.lastIndexOf("```");
  if (open === -1 || close <= open) {
    throw new Error(
      `No \`\`\`ts fence in ${label} — has API Extractor's report format changed? ` +
        "Nothing downstream of the report can be built without it.",
    );
  }
  return lines.slice(open + 1, close).join("\n");
}

/** API Extractor's trailing marker, identical in every report it writes. */
export function stripPackageDocumentationMarker(body) {
  return body
    .replace(/\n*\/\/ \(No @packageDocumentation comment for this package\)\n*$/, "")
    .trim();
}

function declarationName(statement) {
  if (
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isModuleDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  ) {
    return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name))
      .map((declaration) => declaration.name.text);
  }
  return [];
}

const isExported = (statement) =>
  statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

/**
 * Code-unit order, NOT `localeCompare`.
 *
 * These names are written into committed artifacts (`API-EXPORTS.json`, the
 * epoch metadata) that a gate then compares byte for byte, and `localeCompare`
 * with no explicit locale answers to the runtime's — so the same tree would
 * produce a different file on a machine with a different ICU default, and the
 * gate would report a surface change that is really a locale change.
 *
 * DEFINED in `_fs.mjs` and re-exported here, where the argument lives: this
 * module requires api-extractor's bundled TypeScript at load time, and the other
 * two artifact sorts that need the rule (the ratchet baselines, the gateway
 * model catalog) must not import a compiler to sort strings.
 */
export { compareNames } from "./_fs.mjs";

/**
 * The `.d.ts` entry points of one package's `exports` map, with their slugs.
 *
 * ONE definition, because the two callers are coupled by a FILENAME:
 * `api-report.mjs` writes `etc/<slug>.api.md` and `_api-contracts-tree.mjs`
 * looks the same slug back up to read it. Each had its own scan and its own copy
 * of the `"." -> "index"` rule, so a divergence between them would surface as a
 * "missing report" naming a path no human ever typed.
 *
 * Skips three shapes that have no API to report: an asset (`./styles.css`), the
 * manifest itself (`./package.json`), and a wildcard subpath
 * (`./default-client/*`), which names a directory of built assets rather than a
 * module with a signature.
 *
 * Sorted by slug with `compareNames`, never `localeCompare` — the order decides
 * the section order of the committed `API.md`.
 *
 * @param {{ exports?: Record<string, import("./_fs.mjs").ExportTarget> }} manifest
 * @returns {{ subpath: string, types: string, slug: string }[]}
 */
export function typedEntryPoints(manifest) {
  const found = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (subpath.includes("*")) continue;
    const types = typeof target === "string" ? target : target?.types;
    if (typeof types !== "string" || !types.endsWith(".d.ts")) continue;
    found.push({ subpath, types, slug: entryPointSlug(subpath) });
  }
  return found.sort((a, b) => compareNames(a.slug, b.slug));
}

/** `"." -> "index"`; `"./stt" -> "stt"`; `"./default-client/x" -> "default-client-x"`. */
export function entryPointSlug(subpath) {
  return subpath === "." ? "index" : subpath.replace(/^\.\//, "").replaceAll("/", "-");
}

/** The release tag API Extractor stamped in the comment above a declaration. */
function releaseTag(leading) {
  if (/@internal\b/.test(leading)) return "internal";
  if (/@public\b/.test(leading)) return "public";
  return "none";
}

/** The names an `export { … }` statement re-exports, with their type-ness. */
function reExportedNames(statement) {
  if (!(statement.exportClause && ts.isNamedExports(statement.exportClause))) return [];
  return statement.exportClause.elements.map((specifier) => ({
    name: specifier.name.text,
    tag: "none",
    isType: statement.isTypeOnly || specifier.isTypeOnly,
  }));
}

/**
 * Every name one report EXPORTS, with the release tag API Extractor stamped
 * above it and whether it is a type-only declaration.
 *
 * The tag is read from the leading comment rather than from a TSDoc parse
 * because that comment IS the report's own record of it — `// @internal`,
 * `// @public (undocumented)` — and re-deriving it from the source would be a
 * second answer that can disagree with the file being reviewed.
 *
 * `export { X }` forms are collected too. API Extractor emits them for symbols
 * it re-exports without inlining (a type owned by a dependency), and those are
 * as importable as anything it declares; they carry no tag of their own.
 */
export function collectExports(report, label = "an API report") {
  const source = reportSource(report, label);
  const sourceFile = ts.createSourceFile(
    "api-report.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  /** @type {Map<string, { name: string, tag: string, isType: boolean }>} */
  const found = new Map();
  for (const statement of sourceFile.statements) {
    const entries = ts.isExportDeclaration(statement)
      ? reExportedNames(statement)
      : declarationEntries(statement, source, sourceFile);
    // First writer wins, so an overload set collapses to one entry rather than
    // to its last signature's tag.
    for (const entry of entries) if (!found.has(entry.name)) found.set(entry.name, entry);
  }
  return [...found.values()].sort((a, b) => compareNames(a.name, b.name));
}

/** The names a plain exported declaration contributes, with its release tag. */
function declarationEntries(statement, source, sourceFile) {
  if (!isExported(statement)) return [];
  const tag = releaseTag(source.slice(statement.pos, statement.getStart(sourceFile)));
  const isType = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
  return declarationName(statement).map((name) => ({ name, tag, isType }));
}

/**
 * The names one report exports, sorted and de-duplicated.
 *
 * Overloads collapse to one entry, which is what makes this list a statement
 * about the surface rather than about the file: adding an overload changes the
 * report — where a reviewer should see it — and leaves the export list alone,
 * which is exactly the split that makes committing both worthwhile.
 */
export function collectExportedNames(report, label = "an API report") {
  return collectExports(report, label).map((entry) => entry.name);
}
