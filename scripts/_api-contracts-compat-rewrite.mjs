#!/usr/bin/env node

/**
 * The three text rewrites `_api-contracts-compat.mjs` applies to both rollups
 * before it compiles them — each one making two SEPARATELY compiled modules
 * agree about something that is one thing in a consumer's program:
 *
 * 1. **`unique symbol` brands are ONE symbol.** `declare const runtimeBrand:
 *    unique symbol` in each rollup is two distinct symbols to the checker, so
 *    `readonly [runtimeBrand]: true` made every branded type unrelated to its
 *    own twin and even an added OPTIONAL member probed as a break ("Property
 *    '[sessionAuthBrand]' is missing"). A consumer has exactly one
 *    `runtimeBrand`, so a const declared `unique symbol` under the SAME name on
 *    both sides is replaced by an import from a shared module. A renamed brand
 *    is two names and stays two symbols — still a break.
 * 2. **Message literals read as one marker type.** The hash reads a string
 *    literal type longer than {@link LONG_STRING} characters as `string`
 *    (`isMessageLiteral`), so a reworded misuse diagnostic does not move it;
 *    the probe compared the literals and called the same rewording a break.
 *    Both rollups now read such a literal — and a TEMPLATE literal type whose
 *    literal text is that long, the `${K}`-interpolated misuse messages — as
 *    `__AaiMisuse`, a `unique symbol` type from the shared module. Not
 *    `string`: a field that used to accept any string and now carries a misuse
 *    message (a newly FORBIDDEN field) must still differ, and `string` on both
 *    sides would hide exactly that. A `const`'s literals are skipped, as the
 *    hash skips them: `__Widen` already reads them as their primitive.
 * 3. **A `@sealed` type is the SAME type everywhere but its own probe.** An
 *    author only RECEIVES a sealed type (it is built by the SDK, and a brand
 *    usually makes that true), so its own probe is new-to-old only — and every
 *    other position that mentions it (`connectSession(runtime: Runtime)`) is
 *    holding a value the SDK handed over, which is the NEW one. So the other
 *    probes compare against a MASKED copy of the new rollup in which each
 *    sealed declaration is an alias of the old one; the sealed type's own
 *    probe compares against the real new declaration. Without the mask, a
 *    sealed handle gaining a required member failed every function that
 *    accepts it back.
 *
 * Reads the rollup with api-extractor's bundled TypeScript, the parser the
 * compat probe uses (see its header); the output is text.
 */

import { createRequire } from "node:module";
import { isMessageLiteral, LONG_STRING } from "./_api-contracts-hash.mjs";
import { declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/** The module both sides import their brands and the misuse marker from. */
export const SHARED_MODULE = "shared.ts";
const MARKER = "__AaiMisuse";
/** The name a sealed type is re-exported under, so the other side can reach an unexported one. */
export const sealedAlias = (name) => `__sealed_${name}`;

const isConstStatement = (statement) =>
  ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

const isExported = (statement) =>
  (ts.getModifiers?.(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * Whether a statement's own leading comments carry `@sealed` — API Extractor
 * writes the TSDoc modifier onto the release-tag line (`// @public @sealed`);
 * a `/** … @sealed … *\/` block is read too.
 */
export function isSealedStatement(statement, sourceFile) {
  const text = sourceFile.text;
  return (ts.getLeadingCommentRanges(text, statement.pos) ?? []).some((range) =>
    /@sealed\b/.test(text.slice(range.pos, range.end)),
  );
}

/** The names a statement declares as `const X: unique symbol`. */
export function uniqueSymbolNames(statement) {
  if (!isConstStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    const type = declaration.type;
    const unique =
      type !== undefined &&
      ts.isTypeOperatorNode(type) &&
      type.operator === ts.SyntaxKind.UniqueKeyword &&
      type.type.kind === ts.SyntaxKind.SymbolKeyword &&
      ts.isIdentifier(declaration.name);
    return unique ? [declaration.name.text] : [];
  });
}

/** A template literal type's literal text — the part a reworded message changes. */
const templateText = (node) =>
  node.head.text + node.templateSpans.map((span) => span.literal.text).join("");

const isMessage = (node) =>
  isMessageLiteral(node) ||
  (ts.isTemplateLiteralTypeNode(node) && templateText(node).length > LONG_STRING);

function messageEdits(statement, sourceFile, edits) {
  if (isConstStatement(statement)) return;
  const walk = (node) => {
    if (isMessage(node)) {
      edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), to: MARKER });
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(statement);
}

/** The shared module: one declaration per brand, and the misuse marker. */
export function sharedModule(brands) {
  return [
    ...[...brands].map((name) => `export declare const ${name}: unique symbol;`),
    "declare const __aaiMisuse: unique symbol;",
    `export type ${MARKER} = typeof __aaiMisuse;`,
    "",
  ].join("\n");
}

/** A whole statement's replacement, spanning its text but not its comments. */
const replace = (statement, sourceFile, to) => ({
  start: statement.getStart(sourceFile),
  end: statement.getEnd(),
  to,
});

/** A shared brand's declaration as an import of the shared one (re-exported if it was exported). */
function brandImport(statement, symbols) {
  const reExport = isExported(statement) ? ` export { ${symbols.join(", ")} };` : "";
  return `import { ${symbols.join(", ")} } from "./${SHARED_MODULE}";${reExport}`;
}

/** A masked sealed declaration: an alias of the OLD module's, under this one's type parameters. */
function maskedAlias(statement, sourceFile, name) {
  const params = statement.typeParameters ?? [];
  const list =
    params.length === 0 ? "" : `<${params.map((p) => p.getText(sourceFile)).join(", ")}>`;
  const args = params.length === 0 ? "" : `<${params.map((p) => p.name.text).join(", ")}>`;
  const exported = isExported(statement) ? "export " : "";
  return `${exported}type ${name}${list} = __SealedOld.${sealedAlias(name)}${args};`;
}

/**
 * One side's rollup rewritten for the probe program.
 *
 * @param {string} body the rollup, methods already rewritten as properties
 * @param {{ brands: Set<string>, exportSealed?: string[], mask?: string[] }} plan
 *   `brands`: the names to import from the shared module; `exportSealed`: the
 *   sealed names to re-export under `__sealed_<name>`, so the other side can
 *   reach an unexported one; `mask`: the sealed names whose declaration here
 *   becomes an alias of `old.ts`'s `__sealed_<name>` (the masked module only).
 */
export function rewriteForProbe(body, { brands, exportSealed = [], mask = [] }) {
  const sourceFile = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true);
  const toMask = new Set(mask);
  const masked = new Set();
  const edits = [];
  for (const statement of sourceFile.statements) {
    const symbols = uniqueSymbolNames(statement);
    const [name] = declarationNames(statement);
    if (symbols.length > 0 && symbols.every((symbol) => brands.has(symbol))) {
      edits.push(replace(statement, sourceFile, brandImport(statement, symbols)));
    } else if (name !== undefined && toMask.has(name)) {
      // A merged interface declares one name in several statements; the
      // first becomes the alias and the rest go.
      const alias = masked.has(name) ? "" : maskedAlias(statement, sourceFile, name);
      masked.add(name);
      edits.push(replace(statement, sourceFile, alias));
    } else {
      messageEdits(statement, sourceFile, edits);
    }
  }
  let out = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
  }
  const tail = [`import type { ${MARKER} } from "./${SHARED_MODULE}";`];
  if (toMask.size > 0) tail.push('import type * as __SealedOld from "./old.ts";');
  for (const name of exportSealed) tail.push(`export type { ${name} as ${sealedAlias(name)} };`);
  return `${out}\n\n${tail.join("\n")}\n`;
}
