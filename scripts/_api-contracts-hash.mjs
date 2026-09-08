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
 * The principle is the one already stated for API Extractor's preamble in
 * "The authoring surface is versioned in epochs" (`docs/CLAUDE.md`): a hash
 * that moves for a change nobody can observe does not record a decision, it
 * extracts one — and 268 epochs of recorded reasons say what that costs.
 * **114 of them (43%) carry a reason that admits, in its own words, that the
 * superseded epoch "would in fact still compile".** Each of those is a
 * paragraph somebody wrote to explain that nothing happened.
 *
 * Two classes are normalized away here, both measured off that record:
 *
 * 1. **Parameter names** (see {@link renameParameters}). One PR — `opts` to
 *    `options` — forced 36 capability classifications, every one recorded with
 *    the same sentence: "TypeScript parameters are positional, so the
 *    superseded epoch compiles unchanged — but the names are in the report, so
 *    the hash moves."
 * 2. **Declarations another capability owns** (see {@link hashableBody}). 38%
 *    of all hashed lines, and 74% of `aai:tool`'s, are the BODY of a type some
 *    other capability contracts — so `tool` was five times likelier to be
 *    bumped by somebody else's change than by one to its own surface. That
 *    produced 35 drops whose reason begins "Collateral:".
 *
 * What is NOT normalized, and why the gate still has teeth: the set of names a
 * capability reaches is hashed even when their shapes are not, so a foreign
 * type appearing or disappearing from the surface still moves the hash. And
 * the real backward-compatibility test was never the hash — it is the frozen
 * example under `contracts/compatibility/`, which `pnpm typecheck` compiles.
 * A foreign type that breaks reddens every retained epoch that uses it,
 * whichever capability owns the name.
 */

import { createRequire } from "node:module";

import { declarationNames } from "./_api-surface.mjs";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

/**
 * The marker a foreign declaration collapses to.
 *
 * It carries the NAME and deliberately not the owning capability: moving a
 * name between two capabilities of the same package changes who classifies its
 * next reshape, but breaks nobody's code, and naming the owner here would make
 * that reassignment bump every capability that reaches it — the exact class of
 * spurious bump this file exists to remove.
 */
const foreignMarker = (names) => `// (contracted elsewhere) ${names.join(", ")}`;

/** Signature-like nodes own a parameter scope; a nested one is not this one. */
const hasParameters = (node) => node.parameters !== undefined;

/**
 * Parameter names, positionally.
 *
 * TypeScript has no named arguments: a parameter's name is documentation, and
 * renaming one cannot make a caller stop compiling. It is still a real change
 * to the reference a reader uses, which is why it stays in the committed
 * `etc/*.api.md` report and why `pnpm check:api-report` fails until that is
 * regenerated — a reviewer sees the rename in the diff either way. What it is
 * not is a compatibility decision, and only compatibility decisions belong in
 * an epoch.
 *
 * A `this` parameter keeps its name: it is a keyword in that position, not an
 * identifier a caller passes. A destructured parameter has no single name to
 * normalize and is left alone.
 *
 * A type predicate (`value is Foo`) names a parameter in its own text, so it is
 * rewritten alongside — otherwise renaming the parameter of a guard would move
 * the hash through the predicate while the parameter itself was normalized,
 * which is the same spurious bump wearing a hat.
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
    // A nested signature opens its own parameter scope; its predicates are its
    // own business and are reached by the walk in `collectEdits`.
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

/** Every parameter scope inside one top-level declaration. */
function collectEdits(node, sourceFile, edits) {
  if (hasParameters(node)) renameParameters(node, sourceFile, edits);
  ts.forEachChild(node, (child) => collectEdits(child, sourceFile, edits));
}

/**
 * The text an epoch's `sha256` is taken over.
 *
 * @param {string} body the rollup inside the report's ```ts fence
 * @param {Set<string>} foreign names another capability of the same package
 *   contracts. Always the FULL set for the package, never just the
 *   capabilities being regenerated — `--bump` extracts one capability and the
 *   check extracts them all, and a hash that depended on which were asked for
 *   would have the bump write a value the very next check disagreed with.
 */
export function hashableBody(body, foreign) {
  const sourceFile = ts.createSourceFile(
    "contract.d.ts",
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const edits = [];
  for (const statement of sourceFile.statements) {
    const names = declarationNames(statement);
    // Every name a statement declares must be foreign: a `declare const` with
    // two declarators, one of them ours, is ours.
    if (names.length > 0 && names.every((name) => foreign.has(name))) {
      // From the FULL start, so the release tag (`// @public (undocumented)`)
      // goes with it — whether a foreign type happens to carry a doc comment
      // is not this capability's contract either.
      edits.push({
        start: statement.getFullStart(),
        end: statement.getEnd(),
        to: `\n\n${foreignMarker(names)}`,
      });
      continue;
    }
    collectEdits(statement, sourceFile, edits);
  }

  edits.sort((a, b) => b.start - a.start);
  let out = body;
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
  return out.trim();
}
