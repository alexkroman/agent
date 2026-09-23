#!/usr/bin/env node

/**
 * What an epoch hash is SENSITIVE to.
 *
 * `_api-contracts.mjs` turns a capability into an API Extractor report; this
 * decides which parts of that report a change has to be CLASSIFIED for. The
 * two are separate files because they answer different questions: that one is
 * plumbing, this one is policy, and every line here is a deliberate decision
 * that some textual difference cannot break a consumer.
 *
 * The principle is the one stated for API Extractor's preamble in "The
 * authoring surface is versioned in epochs" (`docs/CLAUDE.md`): a hash that
 * moves for a change nobody can observe does not record a decision, it
 * extracts one. The classes normalized away, each measured off the record:
 *
 * 1. **Parameter names** (see {@link renameParameters}). One PR — `opts` to
 *    `options` — forced 36 classifications, each saying "compiles unchanged".
 * 2. **Declarations another capability owns** collapse to their NAME. 74% of
 *    `aai:tool`'s hashed lines were somebody else's type.
 * 3. **Only what a capability's OWN surface reaches directly** (rule 2, G3).
 *    The walk starts at the capability's exports, follows identifiers through
 *    its own and UNOWNED declarations, and stops at a foreign one — whose name
 *    is recorded and whose body, and everything only IT reaches, is not. The
 *    old rule hashed the full transitive set of foreign names, so one new type
 *    reachable through `ToolContext` bumped `state`, `step`, `subagent` and
 *    `coding` with no change of their own.
 * 4. **Presentation** (rule 2, G5): comments (release tags, `(undocumented)`,
 *    `@deprecated`), import-block FORM (`import` vs `import type`, order, and
 *    imports nothing hashed uses), whitespace — the statements are re-printed
 *    by the TypeScript printer. String literal types longer than
 *    {@link LONG_STRING} characters read as `string`, and a `const`'s literal
 *    VALUES read as their primitive, so the key set and value kinds are hashed
 *    and the values are not (`aai:defaults` bumped on every prompt edit).
 *
 * What is NOT normalized: every reached declaration's structure, every
 * foreign name reached directly, and every UNOWNED declaration's body — which
 * `_api-contracts-ownership.mjs` fails on unless it is baselined, because a
 * body hashed in several capabilities is several epochs per change.
 */

import { createRequire } from "node:module";

import { compareNames, declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/**
 * The hash RULE's version, stamped on every epoch record written under it.
 *
 * A record from an older rule has a sha nothing can reproduce, so the
 * point-back search in `_api-contracts-mint.mjs` must not compare against it —
 * equal text under two different rules is a coincidence, not a match.
 */
export const HASH_RULE = 2;

/** Longer string literal types than this read as `string` (G5). */
export const LONG_STRING = 80;

const foreignMarker = (names) => `// (contracted elsewhere) ${names.join(", ")}`;

/** Signature-like nodes own a parameter scope; a nested one is not this one. */
const hasParameters = (node) => node.parameters !== undefined;

/**
 * Parameter names, positionally. TypeScript has no named arguments, so a
 * rename cannot make a caller stop compiling. A `this` parameter keeps its
 * name; a type predicate naming a parameter is rewritten with it.
 */
function renameParameters(node, sourceFile, edits) {
  const renames = new Map();
  node.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const from = parameter.name.text;
    if (from === "this") return;
    const to = `p${index}`;
    if (from === to) return;
    renames.set(from, to);
    edits.push({ start: parameter.name.getStart(sourceFile), end: parameter.name.getEnd(), to });
  });
  if (renames.size === 0 || node.type === undefined) return;

  const rewritePredicates = (child) => {
    if (child !== node.type && hasParameters(child)) return;
    if (ts.isTypePredicateNode(child) && ts.isIdentifier(child.parameterName)) {
      const to = renames.get(child.parameterName.text);
      if (to !== undefined) {
        edits.push({
          start: child.parameterName.getStart(sourceFile),
          end: child.parameterName.getEnd(),
          to,
        });
      }
    }
    ts.forEachChild(child, rewritePredicates);
  };
  rewritePredicates(node.type);
}

/** The primitive a literal type widens to, or undefined for `null` and friends. */
function primitiveOf(literal) {
  switch (literal.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return "string";
    case ts.SyntaxKind.NumericLiteral:
      return "number";
    case ts.SyntaxKind.BigIntLiteral:
      return "bigint";
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
      return "boolean";
    case ts.SyntaxKind.PrefixUnaryExpression:
      return primitiveOf(literal.operand);
    default:
      return;
  }
}

const isFunctionLike = (node) =>
  ts.isFunctionTypeNode(node) ||
  ts.isConstructorTypeNode(node) ||
  ts.isMethodSignature(node) ||
  ts.isCallSignatureDeclaration(node) ||
  ts.isConstructSignatureDeclaration(node);

/**
 * A `const`'s literal values, reduced to their primitive: `readonly timeoutMs:
 * 30000` hashes as `readonly timeoutMs: number`. The key set and each value's
 * kind stay contracted; the value is behaviour, and a changeset's business.
 * Function types inside are left alone — a parameter's literal union is shape.
 */
function widenConstLiterals(statement, sourceFile, edits) {
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  const walk = (node) => {
    if (isFunctionLike(node)) return;
    if (ts.isLiteralTypeNode(node)) {
      const to = primitiveOf(node.literal);
      if (to !== undefined)
        edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), to });
      return;
    }
    ts.forEachChild(node, walk);
  };
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.type !== undefined) walk(declaration.type);
    const init = declaration.initializer;
    const to = init === undefined ? undefined : primitiveOf(init);
    if (to !== undefined && declaration.type === undefined) {
      edits.push({ start: declaration.name.getEnd(), end: init.getEnd(), to: `: ${to}` });
    }
  }
  return true;
}

/** Every normalization edit inside one top-level statement. */
function collectEdits(statement, sourceFile, edits) {
  const isConst = ts.isVariableStatement(statement)
    ? widenConstLiterals(statement, sourceFile, edits)
    : false;
  const walk = (node) => {
    if (hasParameters(node)) renameParameters(node, sourceFile, edits);
    if (!isConst && isMessageLiteral(node)) {
      edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), to: "string" });
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(statement);
}

/**
 * A string literal TYPE long enough to be a sentence rather than a shape — in
 * practice a misuse diagnostic (`"a tool is declared by its FILE, not here …"`)
 * whose wording is prose, not contract. Exported because the compatibility
 * probe has to read these the same way the hash does, or a reworded message
 * the hash forgives would still probe as a break.
 */
export const isMessageLiteral = (node) =>
  ts.isLiteralTypeNode(node) &&
  ts.isStringLiteral(node.literal) &&
  node.literal.text.length > LONG_STRING;

function applyEdits(text, edits) {
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of edits) {
    if (edit.end > previousStart) {
      throw new Error(
        "api-contracts: overlapping normalization edits while hashing a capability report. " +
          "This is a bug in _api-contracts-hash.mjs, not in the surface being hashed.",
      );
    }
    out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
    previousStart = edit.start;
  }
  return out;
}

const parse = (text) =>
  ts.createSourceFile("contract.d.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const hasExportModifier = (statement) =>
  (ts.getModifiers?.(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Every identifier a statement mentions, its own declared names excluded. */
export function referencedNames(statement) {
  const found = new Set();
  const walk = (node) => {
    if (ts.isIdentifier(node)) found.add(node.text);
    ts.forEachChild(node, walk);
  };
  walk(statement);
  for (const name of declarationNames(statement)) found.delete(name);
  return found;
}

/** One import clause's bindings as `{ local, imported, module, kind }`. */
function importBindings(statement) {
  const module = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (clause === undefined) return [];
  const out = [];
  if (clause.name !== undefined) out.push({ local: clause.name.text, kind: "default", module });
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    out.push({ local: bindings.name.text, kind: "namespace", module });
  } else if (bindings !== undefined) {
    for (const element of bindings.elements) {
      out.push({
        local: element.name.text,
        imported: (element.propertyName ?? element.name).text,
        kind: "named",
        module,
      });
    }
  }
  return out;
}

/** The used imports in one canonical form: `import` (never `import type`), sorted. */
function canonicalImports(bindings) {
  const byModule = new Map();
  for (const binding of bindings) {
    if (!byModule.has(binding.module)) byModule.set(binding.module, []);
    byModule.get(binding.module).push(binding);
  }
  const lines = [];
  for (const module of [...byModule.keys()].sort(compareNames)) {
    const entries = byModule.get(module);
    for (const b of entries.filter((entry) => entry.kind !== "named")) {
      lines.push(
        b.kind === "default"
          ? `import ${b.local} from "${module}";`
          : `import * as ${b.local} from "${module}";`,
      );
    }
    const named = entries
      .filter((entry) => entry.kind === "named")
      .map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`))
      .sort(compareNames);
    if (named.length > 0) lines.push(`import { ${named.join(", ")} } from "${module}";`);
  }
  return lines;
}

/**
 * Walk one rollup from its exports and classify every declaration it reaches.
 *
 * @param {string} body the rollup inside the report's ```ts fence
 * @param {Set<string>} foreign names another capability of the same package
 *   contracts — always the FULL set for the package, so `--bump` (one
 *   capability) and the check (all of them) agree on every hash.
 * @returns {{ hashable: string, own: string[], unowned: string[], foreignRefs: string[] }}
 */
export function analyzeBody(body, foreign) {
  const sourceFile = parse(body);
  const index = indexBody(sourceFile.statements);
  const { reached, usedImports, foreignRefs } = walkFromExports(index, foreign);
  const order = [...reached].sort((a, b) => a - b);

  const edits = [];
  for (const at of order) collectEdits(sourceFile.statements[at], sourceFile, edits);
  const edited = parse(applyEdits(body, edits));
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const printed = order.map((at) =>
    printer.printNode(ts.EmitHint.Unspecified, edited.statements[at], edited),
  );
  const unowned = order
    .flatMap((at) => declarationNames(sourceFile.statements[at]))
    .filter((name) => !index.own.has(name));
  const parts = [
    canonicalImports([...usedImports].map((name) => index.imports.get(name))).join("\n"),
    index.reExports.length > 0
      ? `export { ${[...index.reExports].sort(compareNames).join(", ")} };`
      : "",
    printed.join("\n\n"),
    foreignRefs.size > 0 ? foreignMarker(sortedNames(foreignRefs)) : "",
  ];
  return {
    hashable: parts.filter(Boolean).join("\n\n").trim(),
    own: sortedNames(index.own),
    unowned: sortedNames(new Set(unowned)),
    foreignRefs: sortedNames(foreignRefs),
  };
}

const sortedNames = (names) => [...names].sort(compareNames);

/** A body's statements indexed by the names they declare, import and export. */
function indexBody(statements) {
  const index = {
    statements,
    declared: new Map(),
    imports: new Map(),
    reExports: [],
    own: new Set(),
  };
  statements.forEach((statement, at) => {
    indexStatement(index, statement, at);
  });
  return index;
}

function indexStatement(index, statement, at) {
  if (ts.isImportDeclaration(statement)) {
    for (const binding of importBindings(statement)) index.imports.set(binding.local, binding);
    return;
  }
  if (ts.isExportDeclaration(statement)) {
    for (const element of statement.exportClause?.elements ?? []) {
      index.reExports.push(element.name.text);
      index.own.add(element.name.text);
    }
    return;
  }
  const exported = hasExportModifier(statement);
  for (const name of declarationNames(statement)) {
    if (!index.declared.has(name)) index.declared.set(name, []);
    index.declared.get(name).push(at);
    if (exported) index.own.add(name);
  }
}

/**
 * Breadth-first from the exports through every non-foreign declaration; a
 * foreign one is recorded by name and not entered.
 */
function walkFromExports({ statements, declared, imports, own }, foreign) {
  const isForeign = (at) => {
    const names = declarationNames(statements[at]);
    return names.length > 0 && names.every((name) => foreign.has(name) && !own.has(name));
  };
  const reached = new Set();
  const usedImports = new Set();
  const foreignRefs = new Set();
  const queue = [];
  const visit = (name) => {
    if (imports.has(name)) usedImports.add(name);
    for (const at of declared.get(name) ?? []) {
      if (isForeign(at)) foreignRefs.add(name);
      else if (!reached.has(at)) {
        reached.add(at);
        queue.push(at);
      }
    }
  };
  for (const name of own) visit(name);
  while (queue.length > 0) {
    for (const name of referencedNames(statements[queue.shift()])) visit(name);
  }
  return { reached, usedImports, foreignRefs };
}

/** The text an epoch's `sha256` is taken over. See {@link analyzeBody}. */
export function hashableBody(body, foreign) {
  return analyzeBody(body, foreign).hashable;
}
