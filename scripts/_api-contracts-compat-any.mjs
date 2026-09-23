#!/usr/bin/env node

/**
 * The one-sided-`any` walk behind `_api-contracts-compat.mjs`: `any` is
 * assignable both ways, so a probed position that is `any` on one side only
 * proves nothing, and this reports each one by path. The argument is in that
 * module's header.
 */

import { createRequire } from "node:module";

const checkerTs = createRequire(import.meta.url)("typescript-6");

/** How deep the one-sided-`any` walk descends into a probed pair before it stops looking. */
const ANY_WALK_DEPTH = 12;
/** Enough findings to name the problem; a type full of `any` would otherwise print pages. */
const ANY_FINDINGS_PER_NAME = 5;

// An unresolved name is `any` to the checker too (its error type); the diagnostic already reports it.
const isAny = (type) =>
  (type.flags & checkerTs.TypeFlags.Any) !== 0 && type.intrinsicName !== "error";
const isReference = (type) =>
  (type.flags & checkerTs.TypeFlags.Object) !== 0 &&
  (type.objectFlags & checkerTs.ObjectFlags.Reference) !== 0;
const isStructured = (type) =>
  (type.flags & (checkerTs.TypeFlags.Object | checkerTs.TypeFlags.Intersection)) !== 0;
const NULLISH = checkerTs.TypeFlags.Undefined | checkerTs.TypeFlags.Null | checkerTs.TypeFlags.Void;

/**
 * `T | undefined` (or `| null`) as `T`, when that leaves ONE type; else the
 * type unchanged. Read straight off the union rather than through
 * `checker.getNonNullableType`, which resolves a type parameter's base
 * constraint to answer and overflows the stack on `dialog`'s recursive ones
 * when asked from outside a check.
 */
function withoutNullish(type) {
  if ((type.flags & checkerTs.TypeFlags.Union) === 0) return type;
  const rest = type.types.filter((member) => (member.flags & NULLISH) === 0);
  return rest.length === 1 && rest[0] !== undefined ? rest[0] : type;
}

/**
 * The arguments of a pair that instantiate ONE generic declaration on both
 * sides, or `undefined`. Old and new rollups are separate modules, so a shared
 * declaration is one neither rollup owns (lib, another package); its members
 * are that declaration instantiated with these arguments, so they are the
 * whole of what can differ — and walking the members instead descends into
 * `Array.prototype.concat`'s overloads and reports `any`s lib put there.
 */
function sharedGenericArguments(checker, before, after) {
  if (before.aliasSymbol !== undefined && before.aliasSymbol === after.aliasSymbol) {
    return [before.aliasTypeArguments ?? [], after.aliasTypeArguments ?? []];
  }
  if (isReference(before) && isReference(after) && before.target === after.target) {
    return [checker.getTypeArguments(before), checker.getTypeArguments(after)];
  }
}

/** One signature pair's parameters (by position) and returns. */
function* parameterPairs(checker, signature, other, at) {
  for (const [p, parameter] of signature.parameters.entries()) {
    const otherParameter = other.parameters[p];
    if (otherParameter === undefined) continue;
    yield [
      checker.getTypeOfSymbol(parameter),
      checker.getTypeOfSymbol(otherParameter),
      `${at} parameter ${p + 1} (${parameter.name})`,
    ];
  }
  yield [
    checker.getReturnTypeOfSignature(signature),
    checker.getReturnTypeOfSignature(other),
    `${at} return`,
  ];
}

/** Each call and construct signature's parameters and return, paired by index. */
function* signaturePairs(checker, o, n, path) {
  for (const kind of [checkerTs.SignatureKind.Call, checkerTs.SignatureKind.Construct]) {
    const nSignatures = checker.getSignaturesOfType(n, kind);
    const construct = kind === checkerTs.SignatureKind.Construct ? " new" : "";
    for (const [i, signature] of checker.getSignaturesOfType(o, kind).entries()) {
      const other = nSignatures[i];
      const at = `${path}${construct}(${i === 0 ? "" : `overload ${i + 1}`})`;
      if (other !== undefined) yield* parameterPairs(checker, signature, other, at);
    }
  }
}

/**
 * The positions one level inside a pair, paired: a shared generic's type
 * arguments (and nothing else of it), else properties by name, signatures by
 * index, and index signatures by key type.
 */
function* childPairs(checker, o, n, path) {
  const shared = sharedGenericArguments(checker, o, n);
  if (shared !== undefined) {
    const [oArgs, nArgs] = shared;
    for (const [i, arg] of oArgs.entries()) {
      const other = nArgs[i];
      if (other !== undefined) yield [arg, other, `${path}<${i}>`];
    }
    return;
  }
  if (!(isStructured(o) && isStructured(n))) return;
  for (const property of checker.getPropertiesOfType(o)) {
    const other = checker.getPropertyOfType(n, property.name);
    if (other === undefined) continue;
    yield [
      checker.getTypeOfSymbol(property),
      checker.getTypeOfSymbol(other),
      `${path}.${property.name}`,
    ];
  }
  yield* signaturePairs(checker, o, n, path);
  const nIndexes = checker.getIndexInfosOfType(n);
  for (const info of checker.getIndexInfosOfType(o)) {
    const other = nIndexes.find((candidate) => candidate.keyType === info.keyType);
    if (other !== undefined) yield [info.type, other.type, `${path}[index]`];
  }
}

/**
 * Every position where exactly ONE of `oldType` / `newType` is `any`, as a
 * path from the probed name, walking the pair in parallel (`childPairs`),
 * `T | undefined` read as `T`. A pair that is the SAME type cannot differ and
 * is skipped.
 */
export function oneSidedAny(checker, oldType, newType) {
  const found = [];
  const seen = new Map();
  const visited = (before, after) => {
    const pairs = seen.get(before) ?? new Set();
    const was = pairs.has(after);
    seen.set(before, pairs.add(after));
    return was;
  };
  const report = (before, path) => {
    const at = path === "" ? "the top level" : path.replace(/^\./, "");
    found.push(`\`any\` at ${at} on the ${isAny(before) ? "OLD" : "NEW"} side only`);
  };
  const settled = (before, after, depth) =>
    isAny(before) || before === after || depth > ANY_WALK_DEPTH || visited(before, after);
  const walk = (before, after, path, depth) => {
    if (found.length >= ANY_FINDINGS_PER_NAME) return;
    if (isAny(before) !== isAny(after)) return report(before, path);
    if (settled(before, after, depth)) return;
    const o = withoutNullish(before);
    const n = withoutNullish(after);
    if (o !== before || n !== after) return walk(o, n, path, depth);
    for (const [x, y, at] of childPairs(checker, o, n, path)) walk(x, y, at, depth + 1);
  };
  walk(oldType, newType, "", 0);
  return found;
}

/** The probed name a `__type<N>` / `__value<N>` probe identifier stands for. */
function probedName(id, prefix, probes) {
  return id?.startsWith(prefix) ? probes[Number(id.slice(prefix.length))]?.name : undefined;
}

/**
 * The (old, new) type pairs the probes compare, read back out of the checked
 * program: a type probe's two parameters, a value probe's annotation and
 * initializer.
 */
export function probedPairs(checker, file, probes) {
  return file.statements.flatMap((statement) => {
    if (checkerTs.isFunctionDeclaration(statement))
      return typeProbePair(checker, statement, probes);
    if (checkerTs.isVariableStatement(statement))
      return valueProbePairs(checker, statement, probes);
    return [];
  });
}

/** A `__type<N>` probe's two parameters: the old type and the new. */
function typeProbePair(checker, statement, probes) {
  const name = probedName(statement.name?.text, "__type", probes);
  const [o, n] = statement.parameters;
  if (name === undefined || o?.type === undefined || n?.type === undefined) return [];
  return [
    {
      name,
      before: checker.getTypeFromTypeNode(o.type),
      after: checker.getTypeFromTypeNode(n.type),
    },
  ];
}

/** A `__value<N>` probe's annotation (old) and initializer (new). */
function valueProbePairs(checker, statement, probes) {
  return statement.declarationList.declarations.flatMap(({ name: id, type, initializer }) => {
    const name = checkerTs.isIdentifier(id) ? probedName(id.text, "__value", probes) : undefined;
    if (name === undefined || type === undefined || initializer === undefined) return [];
    return [
      {
        name,
        before: checker.getTypeFromTypeNode(type),
        after: checker.getTypeAtLocation(initializer),
      },
    ];
  });
}
