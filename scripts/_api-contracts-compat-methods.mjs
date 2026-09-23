#!/usr/bin/env node

/**
 * The method rewrite behind `_api-contracts-compat.mjs`: every method member
 * of a rollup as a property of function type, so the checker compares its
 * parameters contravariantly instead of bivariantly. The argument, and the
 * one idiom left a method, are in that module's header.
 *
 * Reads the rollup with api-extractor's bundled TypeScript — the one that
 * wrote it — and returns TEXT, so nothing crosses into the checker's AST.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");

/** A member TypeScript would compare bivariantly: a method signature, or a bodiless class method. */
const isMethod = (member) =>
  ts.isMethodSignature(member) || (ts.isMethodDeclaration(member) && member.body === undefined);

/** Whether `node` names the identifier `name` anywhere inside it. */
function mentions(node, name) {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (child) => mentions(child, name)) ?? false;
}

/**
 * Whether a generic signature intersects one of its own type parameters with
 * a type APPLIED to it — `label: L & Literal<L>`, the literal-only idiom. Two
 * such signatures, even identical ones, cannot be related strictly:
 * TypeScript relates generic signatures by inferring the source's `L` from the
 * target's parameter, gets the whole `L & Literal<L>` (nothing in it is
 * identical to the naked `L`), and must then prove the deferred
 * `Literal<L & Literal<L>>`, which it cannot. Only the method's bivariance
 * passes it, so such a method group is left a method (see the header).
 */
function selfIntersecting(member) {
  const own = new Set((member.typeParameters ?? []).map((p) => p.name.text));
  if (own.size === 0) return false;
  const visit = (node) =>
    (ts.isIntersectionTypeNode(node) && intersectsItself(node, own)) ||
    (ts.forEachChild(node, visit) ?? false);
  return member.parameters.some(visit);
}

/** `T & F<T>` for some `T` in `own`: a naked type parameter beside a part that names it. */
function intersectsItself(node, own) {
  return node.types.some(
    (part) =>
      ts.isTypeReferenceNode(part) &&
      ts.isIdentifier(part.typeName) &&
      own.has(part.typeName.text) &&
      node.types.some((other) => other !== part && mentions(other, part.typeName.text)),
  );
}

/** Whether a member's signature names the polymorphic `this` TYPE (not a `this` parameter). */
function mentionsThis(node) {
  return node.kind === ts.SyntaxKind.ThisType || (ts.forEachChild(node, mentionsThis) ?? false);
}

/**
 * The function type one method group becomes (see the header). One signature
 * is an arrow. An overload set is a call-signature literal, which TypeScript
 * relates exactly as it relates the overloaded method — each target signature
 * matched by some source signature — only without method bivariance. A
 * literal has no `this` type, so an overload set that names one becomes an
 * intersection of arrows instead, which relates each signature on its own.
 */
function functionType(signatures, needsThis) {
  const [only] = signatures;
  if (signatures.length === 1 && only !== undefined) return `${only.head} => ${only.returns}`;
  if (needsThis) return signatures.map((s) => `((${s.head} => ${s.returns}))`).join(" & ");
  return `{ ${signatures.map((s) => `${s.head}: ${s.returns};`).join(" ")} }`;
}

/**
 * The edits turning one member list's methods into properties: one per
 * overload GROUP, at its first member, and an empty one over each later
 * overload. `render` builds the replacement through `rewrite`, so a method
 * nested inside a parameter's type literal is converted too.
 */
function methodEdits(members, sourceFile, edits) {
  const groups = new Map();
  for (const member of members) {
    if (!isMethod(member)) continue;
    const prefix = sourceFile.text.slice(
      member.getStart(sourceFile),
      member.name.getStart(sourceFile),
    );
    const key = `${prefix}${member.name.getText(sourceFile)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { prefix, members: [member] });
    else group.members.push(member);
  }
  for (const { prefix, members: overloads } of groups.values()) {
    if (overloads.some(selfIntersecting)) continue;
    const [first, ...rest] = overloads;
    const name = first.name.getText(sourceFile);
    const optional = first.questionToken === undefined ? "" : "?";
    edits.push({
      start: first.getStart(sourceFile),
      end: first.getEnd(),
      render: (rewriteRange) => {
        const signatures = overloads.map((member) => {
          const head = rewriteRange(
            (member.questionToken ?? member.name).getEnd(),
            member.type?.getStart(sourceFile) ?? member.getEnd(),
          )
            .trim()
            .replace(/\s*[:;,]$/, "");
          const returns =
            member.type === undefined
              ? "any"
              : rewriteRange(member.type.getStart(sourceFile), member.type.getEnd());
          return { head, returns };
        });
        return `${prefix}${name}${optional}: ${functionType(signatures, overloads.some(mentionsThis))};`;
      },
    });
    for (const member of rest) {
      edits.push({ start: member.getStart(sourceFile), end: member.getEnd(), render: () => "" });
    }
  }
}

/** `text[start, end)` with every OUTERMOST edit inside it applied (each renders its own nested ones). */
function rewrite(text, edits, start, end) {
  let out = "";
  let at = start;
  for (const edit of edits) {
    if (edit.start < at || edit.end > end || (edit.start === start && edit.end === end)) continue;
    out += text.slice(at, edit.start) + edit.render((from, to) => rewrite(text, edits, from, to));
    at = edit.end;
  }
  return out + text.slice(at, end);
}

/**
 * A rollup with every method member rewritten as a property of call-signature
 * type, so the checker compares its parameters CONTRAVARIANTLY (see the header).
 */
export function methodsAsProperties(body) {
  const sourceFile = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeLiteralNode(node) ||
      ts.isClassDeclaration(node)
    ) {
      methodEdits(node.members, sourceFile, edits);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // Outermost first: by start, and the longer of two edits sharing one.
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  return rewrite(body, edits, 0, body.length);
}
