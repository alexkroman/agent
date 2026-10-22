#!/usr/bin/env node

/**
 * The SHAPE guards over a contract package's published surface — what
 * `check-api-shape.mjs` measures, as pure functions from committed report text
 * to findings. No filesystem, no git: `packages/aai-gates/src/api-shape.test.ts`
 * feeds these samples directly.
 *
 * `check:api-contracts` decides whether a change that HAPPENED is breaking.
 * These decide whether a shape is one that will KEEP producing breaking
 * changes, which is where the epochs came from in practice:
 *
 * - **direction** (G1): every exported object type a capability reaches is
 *   tagged `@sealed` (the SDK builds it, an author reads it) or `@input` (an
 *   author builds it, the SDK reads it). Untagged, the probe compares it both
 *   ways, so a new required member and a widened union are BOTH breaks — the
 *   most expensive reading, and the one an untagged type gets by default.
 *   `positions` flags a type reached as input AND output (no tag can be true of
 *   it) or one whose tag contradicts where it is reached; `derived` flags an
 *   exported alias cut from another object type with `Omit`/`Pick`/`Partial`,
 *   which ties an input's shape to an output's (`MetricsSample`).
 * - **closedLiterals** (G2): a closed literal set an author RECEIVES — a
 *   `const` typed as a literal tuple, a `Record` over literal keys, a string
 *   literal union without `(string & {})` in output position — grows only by
 *   breaking every exhaustive `switch` written against it.
 * - **nonAuthoringImports** (G3): a capability reaching a name from a
 *   non-authoring subpath (`/internal`, `/host-internal`). The hash sees only
 *   the name of an imported type, so a change behind it is invisible to the
 *   gate that is supposed to version it.
 * - **budgets**, **thirdPartyTypes**, **orphans** (G4): a capability over its
 *   export or line budget is one whose every change bumps one big epoch; a
 *   third-party type (zod internals, xstate, `ai`) moves when that dependency
 *   does; an orphan is a contracted type no contracted signature reaches —
 *   promised, and used by nothing the package promises.
 * - **unexportedShared** (G5): a declaration no subpath exports, hashed into
 *   several capabilities, so one edit moves several hashes and no author can
 *   name what moved.
 *
 * Polarity (input vs output position) is the textbook walk: a value's own type
 * and a function's return are OUTPUT, a parameter flips it, a property keeps
 * it, and a reached declaration is entered with the polarity it was reached
 * at. `@sealed` types are additionally entered as OUTPUT and `@input` types as
 * INPUT, so what a tag claims is checked even when no function reaches it.
 */

import { createRequire } from "node:module";

import { referencedNames } from "./_api-contracts-hash.mjs";
import { compareNames, declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/** Over these, a capability is baselined at its size or split (G4). */
export const DEFAULT_BUDGET = { exports: 40, lines: 600 };

/** Third-party modules whose types a contracted signature may name (G4), and why. */
export const THIRD_PARTY_ALLOWED = {
  "@standard-schema/spec":
    "the vendor-neutral validator interface a tool's input schema is checked against",
  react: "aai-ui is a React component library; its props and hooks are React types",
};

const OUT = "+";
const IN = "-";
const flip = (polarity) => (polarity === OUT ? IN : OUT);

const isExportedStatement = (statement) =>
  (ts.getModifiers?.(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** The `@tag`s on a statement's release-tag comment line (`// @public @sealed`). */
function tagsOf(statement, sourceFile) {
  const tags = new Set();
  for (const range of ts.getLeadingCommentRanges(sourceFile.text, statement.pos) ?? []) {
    for (const match of sourceFile.text.slice(range.pos, range.end).matchAll(/@(\w+)/g)) {
      tags.add(match[1]);
    }
  }
  return tags;
}

/** `{ local → { module, name } }` for one import declaration's named bindings. */
function importBindings(statement) {
  const module = statement.moduleSpecifier.text;
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((e) => [
    e.name.text,
    { module, name: (e.propertyName ?? e.name).text },
  ]);
}

/** Record one declaring statement of `name` under `decls`. */
function addDeclaration(decls, name, statement, slug, sourceFile) {
  const lines = statement.getText(sourceFile).split("\n").length;
  const existing = decls.get(name);
  if (existing === undefined) {
    decls.set(name, {
      name,
      slug,
      statement,
      statements: [statement],
      sourceFile,
      exported: isExportedStatement(statement),
      tags: tagsOf(statement, sourceFile),
      lines,
    });
    return;
  }
  existing.exported ||= isExportedStatement(statement);
  // Overloads and merged declarations: every statement in the report that
  // first declared the name (later reports repeat the same text).
  if (existing.slug !== slug) return;
  existing.statements.push(statement);
  existing.lines += lines;
  for (const tag of tagsOf(statement, sourceFile)) existing.tags.add(tag);
}

/**
 * One package's surface, indexed from its committed report bodies.
 *
 * @param {{ slug: string, body: string }[]} reports
 */
export function indexSurface(reports) {
  const decls = new Map();
  const imports = new Map();
  for (const { slug, body } of reports) {
    const sourceFile = ts.createSourceFile(`${slug}.d.ts`, body, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        for (const [local, binding] of importBindings(statement)) imports.set(local, binding);
        continue;
      }
      for (const name of declarationNames(statement)) {
        addDeclaration(decls, name, statement, slug, sourceFile);
      }
    }
  }
  return { decls, imports };
}

/** Every name any statement of a declaration mentions. */
const declRefs = (decl) => new Set(decl.statements.flatMap((s) => [...referencedNames(s)]));

/** The type an alias or interface stands for as an object, or `undefined`. */
function objectShape(statement) {
  if (ts.isInterfaceDeclaration(statement)) return statement;
  if (!ts.isTypeAliasDeclaration(statement)) return;
  let type = statement.type;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  if (ts.isTypeLiteralNode(type)) return type;
  if (ts.isIntersectionTypeNode(type) && type.types.some(ts.isTypeLiteralNode)) return type;
}

const isObjectType = (decl) => objectShape(decl.statement) !== undefined;
const isTypeDecl = (decl) =>
  ts.isInterfaceDeclaration(decl.statement) || ts.isTypeAliasDeclaration(decl.statement);
const isValueDecl = (decl) => !isTypeDecl(decl);
const isStringLiteral = (node) => ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal);

/** `(string & {})` or plain `string` — what keeps a literal union open. */
function opensUnion(node) {
  if (node.kind === ts.SyntaxKind.StringKeyword) return true;
  let inner = node;
  while (ts.isParenthesizedTypeNode(inner)) inner = inner.type;
  return (
    ts.isIntersectionTypeNode(inner) &&
    inner.types.some((t) => t.kind === ts.SyntaxKind.StringKeyword) &&
    inner.types.some((t) => ts.isTypeLiteralNode(t) && t.members.length === 0)
  );
}

/** A union an author RECEIVES that is closed: ≥2 string literals and nothing opening it. */
const isClosedLiteralUnion = (node) =>
  ts.isUnionTypeNode(node) &&
  node.types.filter(isStringLiteral).length >= 2 &&
  !node.types.some(opensUnion);

/** A `Record<K, V>` whose key is a literal or a union of them. */
function isLiteralRecord(node) {
  if (!ts.isTypeReferenceNode(node) || node.typeName.getText() !== "Record") return false;
  const key = node.typeArguments?.[0];
  if (key === undefined) return false;
  if (isStringLiteral(key)) return true;
  return ts.isUnionTypeNode(key) && key.types.every(isStringLiteral);
}

/** A `const`'s literal tuple type (`readonly ["a", "b"]`, `readonly [string]`). */
function tupleConst(statement) {
  return statement.declarationList.declarations.some(({ type }) => {
    let inner = type;
    if (inner !== undefined && ts.isTypeOperatorNode(inner)) inner = inner.type;
    return inner !== undefined && ts.isTupleTypeNode(inner);
  });
}

/** The declared name a type node references, or `undefined`. */
function referencedName(node) {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return node.typeName.text;
  if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) return node.exprName.text;
}

const isProperty = (node) =>
  (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.type !== undefined;
const isMethod = (node) =>
  (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) && node.name !== undefined;

/**
 * The polarity walk over one type node: a parameter flips it, a property and
 * a method's return keep it, a literal `Record`'s key is skipped (it is
 * reported once, as a Record).
 */
function makeVisitor({ onRef, onUnion }) {
  const visit = (node, p, path) => {
    if (p === OUT && isClosedLiteralUnion(node)) onUnion(path);
    const name = referencedName(node);
    if (name !== undefined) onRef(name, p);
    for (const [child, at, childPath] of children(node, p, path)) visit(child, at, childPath);
  };
  return visit;
}

/** What {@link makeVisitor} descends into from one node, with each child's polarity and path. */
function children(node, p, path) {
  if (ts.isParameter(node)) return node.type === undefined ? [] : [[node.type, flip(p), path]];
  if (isLiteralRecord(node)) return node.typeArguments.slice(1).map((arg) => [arg, p, path]);
  if (isProperty(node)) return [[node.type, p, `${path}.${node.name.getText()}`]];
  if (isMethod(node)) {
    const at = `${path}.${node.name.getText()}`;
    const parts = [...node.parameters, ...(node.type === undefined ? [] : [node.type])];
    return parts.map((part) => [part, p, at]);
  }
  const out = [];
  ts.forEachChild(node, (child) => {
    out.push([child, p, path]);
  });
  return out;
}

/** The top-level parts of one declaring statement to walk at its own polarity. */
function walkRoots(statement) {
  if (ts.isFunctionDeclaration(statement)) {
    return [...statement.parameters, ...(statement.type === undefined ? [] : [statement.type])];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) =>
      d.type === undefined ? [] : [d.type],
    );
  }
  if (ts.isClassDeclaration(statement)) {
    const members = statement.members.flatMap((member) =>
      ts.isConstructorDeclaration(member) ? [...member.parameters] : [member],
    );
    return [...members, ...(statement.heritageClauses ?? [])];
  }
  if (ts.isInterfaceDeclaration(statement)) {
    return [...(statement.heritageClauses ?? []), ...statement.members];
  }
  if (ts.isTypeAliasDeclaration(statement)) return [statement.type];
  return [];
}

/**
 * Walk every type position reachable from one declaration, calling `onUnion`
 * for closed literal unions at OUTPUT polarity and `onRef` for every
 * identifier reference with the polarity it is reached at.
 */
function walkPolarity(decl, polarity, visitors) {
  const visit = makeVisitor(visitors);
  for (const statement of decl.statements) {
    for (const root of walkRoots(statement)) visit(root, polarity, decl.name);
  }
}

/** What one capability reaches: through own and unowned declarations, never into another's. */
function reachOf(capability, names, { decls, imports }, owner) {
  const reached = new Set();
  const reachedImports = new Set();
  const queue = [...names];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const name = queue.shift();
    if (imports.has(name)) reachedImports.add(name);
    const decl = decls.get(name);
    if (decl === undefined || (owner.has(name) && owner.get(name) !== capability)) continue;
    reached.add(name);
    for (const ref of declRefs(decl)) {
      if (!seen.has(ref) && (decls.has(ref) || imports.has(ref))) {
        seen.add(ref);
        queue.push(ref);
      }
    }
  }
  return { reached, reachedImports };
}

const isAllowedThirdParty = (module) =>
  Object.hasOwn(THIRD_PARTY_ALLOWED, module) ||
  Object.hasOwn(THIRD_PARTY_ALLOWED, module.split("/")[0] ?? module);

/** G3 and G4's import findings and G4's budget for one capability's reach. */
function reachFindings(capability, names, reach, { decls, imports }, policy, findings) {
  let lines = reach.reachedImports.size;
  for (const name of reach.reached) lines += decls.get(name).lines;
  const size = { exports: names.size, lines };
  if (size.exports > DEFAULT_BUDGET.exports || size.lines > DEFAULT_BUDGET.lines) {
    findings.budgets[capability] = size;
  }
  for (const local of reach.reachedImports) {
    const { module, name } = imports.get(local);
    const entry = `${capability}: ${name} from ${module}`;
    if (policy.nonAuthoring(module)) findings.nonAuthoringImports.add(entry);
    else if (
      !(policy.isWorkspace(module) || module.startsWith("node:") || isAllowedThirdParty(module))
    ) {
      findings.thirdPartyTypes.add(entry);
    }
  }
}

/** G5: unexported declarations reached from more than one capability. */
function sharedUnexported(reachedBy, decls) {
  const reachers = new Map();
  for (const [capability, { reached }] of reachedBy) {
    for (const name of reached) {
      if (decls.get(name).exported) continue;
      reachers.set(name, [...(reachers.get(name) ?? []), capability]);
    }
  }
  return [...reachers].filter(([, by]) => by.length > 1).map(([name]) => name);
}

/** G4 orphans' complement: every declaration a contracted value's signature reaches. */
function reachedFromValues(decls, ownedValues) {
  const reached = new Set();
  const pending = ownedValues.map((d) => d.name);
  while (pending.length > 0) {
    for (const ref of declRefs(decls.get(pending.shift()))) {
      if (decls.has(ref) && !reached.has(ref)) {
        reached.add(ref);
        pending.push(ref);
      }
    }
  }
  return reached;
}

/**
 * Polarity across the whole package (an output type is output whoever reaches
 * it), and the closed literal unions met at output polarity.
 */
function polarityOf(decls, owner, ownedValues) {
  const polarity = new Map();
  const closedAt = new Set();
  const queue = ownedValues.map((decl) => [decl, OUT]);
  // A tag is a CLAIM about where the type is reached, so its contents are
  // walked at the tagged polarity without marking the type itself reached.
  for (const decl of decls.values()) {
    if (!(owner.has(decl.name) && isTypeDecl(decl))) continue;
    if (decl.tags.has("sealed")) queue.push([decl, OUT]);
    if (decl.tags.has("input")) queue.push([decl, IN]);
  }
  const visitors = {
    onRef: (name, p) => {
      const decl = decls.get(name);
      const seen = polarity.get(name) ?? new Set();
      if (decl === undefined || seen.has(p)) return;
      polarity.set(name, seen.add(p));
      queue.push([decl, p]);
    },
    onUnion: (path) => {
      const capability = owner.get(path.split(".")[0]);
      if (capability !== undefined) closedAt.add(`${capability}: ${path}`);
    },
  };
  while (queue.length > 0) {
    const [decl, p] = queue.shift();
    walkPolarity(decl, p, visitors);
  }
  return { polarity, closedAt };
}

/** G1's `positions` verdict for one object type, or `undefined`. */
function positionFinding(decl, seen) {
  if (seen.has(OUT) && seen.has(IN)) return "reached as input AND output";
  if (decl.tags.has("input") && seen.has(OUT)) return "@input, but reached as output";
  if (decl.tags.has("sealed") && seen.has(IN)) return "@sealed, but reached as input";
}

/** G1's `derived` verdict for one alias: `Omit<Source>` and friends, or `undefined`. */
function derivedFinding(statement, decls) {
  const type = statement.type;
  if (!ts.isTypeReferenceNode(type)) return;
  const helper = type.typeName.getText();
  const source = type.typeArguments?.[0];
  if (!["Omit", "Pick", "Partial", "Required"].includes(helper) || source === undefined) return;
  if (!(ts.isTypeReferenceNode(source) && ts.isIdentifier(source.typeName))) return;
  return decls.has(source.typeName.text) ? `${helper}<${source.typeName.text}>` : undefined;
}

/** G2's per-declaration findings: a literal-tuple const, a Record over literal keys. */
function closedDeclFindings(statement) {
  const out = [];
  if (ts.isTypeAliasDeclaration(statement) && isLiteralRecord(statement.type)) {
    out.push("Record over literal keys");
  }
  if (ts.isVariableStatement(statement)) {
    if (tupleConst(statement)) out.push("literal tuple const");
    const typed = statement.declarationList.declarations.filter((d) => d.type !== undefined);
    if (typed.some((d) => isLiteralRecord(d.type))) out.push("Record over literal keys");
  }
  return out;
}

/** Every per-declaration finding for one owned, exported declaration. */
function declarationFindings(decl, at, context, findings) {
  const { polarity, valueReached, decls } = context;
  if (isObjectType(decl)) {
    if (decl.tags.has("sealed") === decl.tags.has("input")) findings.direction.add(at);
    const position = positionFinding(decl, polarity.get(decl.name) ?? new Set());
    if (position !== undefined) findings.positions.add(`${at} — ${position}`);
  }
  if (ts.isTypeAliasDeclaration(decl.statement)) {
    const derived = derivedFinding(decl.statement, decls);
    if (derived !== undefined) findings.derived.add(`${at} = ${derived}`);
  }
  for (const what of closedDeclFindings(decl.statement))
    findings.closedLiterals.add(`${at} — ${what}`);
  if (isTypeDecl(decl) && !valueReached.has(decl.name)) findings.orphans.add(at);
}

/**
 * Every finding for one package.
 *
 * @param {{ decls: Map<string, any>, imports: Map<string, { module: string, name: string }> }} surface
 * @param {Map<string, Set<string>>} capabilityNames capability → names its entry point selects
 * @param {{ nonAuthoring: (module: string) => boolean, isWorkspace: (module: string) => boolean }} policy
 */
export function shapeFindings(surface, capabilityNames, policy) {
  const { decls } = surface;
  const owner = new Map();
  for (const [capability, names] of capabilityNames) {
    for (const name of names) owner.set(name, capability);
  }
  const findings = {
    direction: new Set(),
    positions: new Set(),
    derived: new Set(),
    closedLiterals: new Set(),
    nonAuthoringImports: new Set(),
    budgets: {},
    thirdPartyTypes: new Set(),
    orphans: new Set(),
    unexportedShared: new Set(),
  };

  const reachedBy = new Map();
  for (const [capability, names] of capabilityNames) {
    const reach = reachOf(capability, names, surface, owner);
    reachedBy.set(capability, reach);
    reachFindings(capability, names, reach, surface, policy, findings);
  }
  for (const name of sharedUnexported(reachedBy, decls)) findings.unexportedShared.add(name);

  const ownedValues = [...decls.values()].filter((d) => owner.has(d.name) && isValueDecl(d));
  const { polarity, closedAt } = polarityOf(decls, owner, ownedValues);
  const context = { polarity, valueReached: reachedFromValues(decls, ownedValues), decls };
  for (const decl of decls.values()) {
    if (!(decl.exported && owner.has(decl.name))) continue;
    declarationFindings(decl, `${owner.get(decl.name)}: ${decl.name}`, context, findings);
  }
  for (const site of closedAt) {
    findings.closedLiterals.add(`${site} — closed literal union in output position`);
  }

  const sorted = (set) => [...set].sort(compareNames);
  return {
    direction: sorted(findings.direction),
    positions: sorted(findings.positions),
    derived: sorted(findings.derived),
    closedLiterals: sorted(findings.closedLiterals),
    nonAuthoringImports: sorted(findings.nonAuthoringImports),
    budgets: Object.fromEntries(Object.entries(findings.budgets).sort()),
    thirdPartyTypes: sorted(findings.thirdPartyTypes),
    orphans: sorted(findings.orphans),
    unexportedShared: sorted(findings.unexportedShared),
  };
}
