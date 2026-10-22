#!/usr/bin/env node

/**
 * The CANONICAL form a capability's reached declarations are printed in before
 * they are hashed (rule 3 of `_api-contracts-hash.mjs`).
 *
 * Every rewrite here is one the compatibility probe already proves harmless —
 * the two spellings are the same type to a consumer — but each used to move the
 * hash, and a moved hash cost a classification run and a record write:
 *
 * 1. **Member order** in an object type (`{ a; b }` vs `{ b; a }`). Property
 *    members are sorted by name; call, construct and index signatures keep
 *    their order (overload order IS observable) and come first.
 * 2. **Union member order** (`"a" | "b"` vs `"b" | "a"`), sorted by text.
 * 3. **`interface` vs `type`** with the same shape: an interface prints as a
 *    type alias, its `extends` list as an intersection in front of its body.
 * 4. **An inlined alias**: an UNEXPORTED, non-generic, non-recursive alias (or
 *    interface, after 3) is substituted at every reference and its declaration
 *    dropped, so `f(a: Opts)` over a forgotten `type Opts = { … }` and
 *    `f(a: { … })` print alike. An EXPORTED name stays a reference: it is a
 *    name an author can import, and the export list contracts it.
 * 5. **Redundant parentheses**, dropped everywhere and re-inserted by the
 *    factory's parenthesizer only where precedence needs them — which is what
 *    lets 4 print an inlined body the way it would have been written.
 *
 * Method-vs-arrow-property (`m(x): R` vs `m: (x) => R`) is the probe's own
 * rewrite (`methodsAsProperties`, `_api-contracts-compat-methods.mjs`), applied
 * by the hash before it parses.
 *
 * Reads with api-extractor's bundled TypeScript, like the hash; the output is
 * text.
 */

import { createRequire } from "node:module";

import { compareNames, declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

const isPropertyLike = (member) => ts.isPropertySignature(member) || ts.isMethodSignature(member);

/** An interface's shape as a type: `A & B & { …members }`. */
function interfaceAsType(node, factory) {
  const heritage = (node.heritageClauses ?? []).flatMap((clause) =>
    clause.types.map((type) =>
      factory.createTypeReferenceNode(
        ts.isIdentifier(type.expression)
          ? type.expression
          : factory.createIdentifier(type.expression.getText()),
        type.typeArguments,
      ),
    ),
  );
  const literal = factory.createTypeLiteralNode(node.members);
  return heritage.length === 0
    ? literal
    : factory.createIntersectionTypeNode([...heritage, literal]);
}

/** Unexported, non-generic aliases and interfaces declared by exactly one statement. */
function candidateAliases(statements, order, exported) {
  const candidates = new Map();
  const declaredAt = new Map();
  for (const at of order) {
    for (const name of declarationNames(statements[at])) {
      declaredAt.set(name, [...(declaredAt.get(name) ?? []), at]);
    }
  }
  for (const at of order) {
    const statement = statements[at];
    const [name] = declarationNames(statement);
    const isAlias = ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement);
    const single = declaredAt.get(name)?.length === 1;
    if (isAlias && single && !exported.has(name) && statement.typeParameters === undefined) {
      candidates.set(name, { at, statement });
    }
  }
  return candidates;
}

/** Every type name a node references. */
function typeReferences(node, found = new Set()) {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) found.add(node.typeName.text);
  ts.forEachChild(node, (child) => {
    typeReferences(child, found);
  });
  return found;
}

/** The candidates that reach themselves through a chain of candidates. */
function recursiveAliases(candidates) {
  const recursive = new Set();
  const visit = (name, stack) => {
    const seenAt = stack.indexOf(name);
    if (seenAt !== -1) {
      for (const member of stack.slice(seenAt)) recursive.add(member);
      return;
    }
    const entry = candidates.get(name);
    if (entry === undefined) return;
    for (const next of typeReferences(entry.statement)) visit(next, [...stack, name]);
  };
  for (const name of candidates.keys()) visit(name, []);
  return recursive;
}

/**
 * The aliases rule 4 substitutes: unexported, without type parameters, and not
 * reaching themselves through any chain of other substitutable aliases.
 */
function inlinableAliases(statements, order, exported) {
  const candidates = candidateAliases(statements, order, exported);
  for (const name of recursiveAliases(candidates)) candidates.delete(name);
  return candidates;
}

/** The inlined body a reference to `node`'s alias stands for, or `undefined`. */
function inlinedBody(node, inline, factory) {
  if (
    !(ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) ||
    node.typeArguments !== undefined
  ) {
    return;
  }
  const entry = inline.get(node.typeName.text);
  if (entry === undefined) return;
  const { statement } = entry;
  return ts.isInterfaceDeclaration(statement)
    ? interfaceAsType(statement, factory)
    : statement.type;
}

/** A visited node with its members or union constituents in canonical order. */
function sortedNode(node, factory, sourceFile) {
  if (ts.isTypeLiteralNode(node)) {
    return factory.createTypeLiteralNode(sortMembers(node.members, sourceFile));
  }
  if (ts.isUnionTypeNode(node)) {
    return factory.createUnionTypeNode([...node.types].sort(byPrinted(sourceFile)));
  }
  return node;
}

/**
 * The reached statements (`order`, indices into `sourceFile.statements`)
 * printed canonically, one string each, sorted — declarations inlined by rule
 * 4 omitted.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {number[]} order
 * @param {Set<string>} exported names an author can import (never inlined)
 */
export function canonicalStatements(sourceFile, order, exported) {
  const { statements } = sourceFile;
  const inline = inlinableAliases(statements, order, exported);
  const inlinedAt = new Set([...inline.values()].map((entry) => entry.at));

  const transformer = (context) => {
    const { factory } = context;
    const visit = (node) => {
      if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
      const body = inlinedBody(node, inline, factory);
      if (body !== undefined) return visit(body);
      if (ts.isInterfaceDeclaration(node)) {
        const alias = factory.createTypeAliasDeclaration(
          node.modifiers,
          node.name,
          node.typeParameters,
          interfaceAsType(node, factory),
        );
        return ts.visitEachChild(alias, visit, context);
      }
      return sortedNode(ts.visitEachChild(node, visit, context), factory, sourceFile);
    };
    return (file) => ts.visitEachChild(file, visit, context);
  };

  const result = ts.transform(sourceFile, [transformer]);
  try {
    const [transformed] = result.transformed;
    return order
      .filter((at) => !inlinedAt.has(at))
      .map((at) =>
        printer.printNode(ts.EmitHint.Unspecified, transformed.statements[at], sourceFile),
      )
      .sort(compareNames);
  } finally {
    result.dispose();
  }
}

const printed = (node, sourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);

const byPrinted = (sourceFile) => (a, b) =>
  compareNames(printed(a, sourceFile), printed(b, sourceFile));

/** Signatures first, in their own order; then property-like members by name (stable). */
function sortMembers(members, sourceFile) {
  const signatures = members.filter((member) => !isPropertyLike(member));
  const named = members
    .filter(isPropertyLike)
    .sort((a, b) => compareNames(printed(a.name, sourceFile), printed(b.name, sourceFile)));
  return [...signatures, ...named];
}
