// Copyright 2026 the AAI authors. MIT license.
/**
 * Where the `test()` / `it()` calls in a source file are, and whether each one
 * asserts anything.
 *
 * Its own module for the reason `guard-invariants-rules.mjs` is: the gate that
 * uses it (`check-test-assertions.mjs`) is a script with top-level effects, and
 * the thing that needs a spec is the PARSER. Importing this rather than
 * regex-scraping the gate's source is the lesson that suite already paid for
 * once — see the third-draft note in `guard-invariants-gate.test.ts`.
 *
 * ## A real parse, not a lexer we maintain
 *
 * This replaced ~140 lines of hand-written JavaScript tokenizer: a comment and
 * string masker, a template-literal walker that had to leave `${…}` intact, a
 * regex-versus-division disambiguator, and a paren balancer. Every one of them
 * existed to answer a question a parser answers for free, and the two bugs the
 * gate's history records were both in that layer — `test()` inside a JSDoc
 * paragraph ABOUT tests (three files here have one), and `/re/.test(x)`, which
 * produced five of the first run's eight reported offenders.
 *
 * The walk and the line index it needs are `scripts/_ast-scan.mjs`'s now — that
 * module is the same parse serving `guard-invariants`' node rules, and this
 * gate was the precedent it generalized. What stays here is the `parseSync`
 * call itself, because this gate's contract is to RETURN parse errors rather
 * than throw on them, and the caller is what decides.
 *
 * `oxc-parser` was already in the lockfile (hono, knip, `@vitest/coverage-v8`
 * and `rolldown-plugin-dts` all pull it); it is a root devDependency now
 * because importing a transitive one directly is a phantom dependency that
 * pnpm's layout refuses. It parses TypeScript and TSX with no config and emits
 * ESTree, so nothing here needs a build step — which was the original argument
 * for hand-rolling, the repo's only other TypeScript parser being the
 * `typescript@6` pinned inside the `docs/` workspace for TypeDoc.
 *
 * **It also sees a whole class the regex could not.** The old opener matched
 * `test(`, `it(`, and exactly one `.word(…)` in between (`test.each([…])(`) —
 * so `test.concurrent("…", fn)` was invisible to the gate, and eleven such
 * tests in `packages/aai-cli/src/e2e.test.ts` asserted nothing while it reported a
 * clean run. Chains are walked here instead of enumerated, so `test.concurrent`,
 * `test.for`, `test.concurrent.for(…)` and `test.each\`…\`` all land.
 */

import { parseSync } from "oxc-parser";

import { lineIndexOf, walk } from "./_ast-scan.mjs";

/** Call roots that open a test body. `describe` is a group, not a test. */
export const TEST_NAMES = new Set(["test", "it"]);

/**
 * Call roots that count as asserting.
 *
 * `expectTypeOf` is here because the type-level suites assert at compile time
 * and legitimately have no runtime `expect`. Membership is by the identifier a
 * call CHAINS FROM, so `expect(x).toBe(1)`, `expect.soft(x, label)`,
 * `expect.fail(msg)` and `assert.equal(a, b)` all count while an ordinary
 * identifier that merely reads like one (`expected`, `unexpectedCalls`) does
 * not — the distinction the old `\b(?:expect|…)\s*[(.<]` regex was spelling by
 * hand.
 */
export const ASSERTERS = new Set(["expect", "expectTypeOf", "assert"]);

/**
 * The identifier a callee expression chains from — `test` for every one of
 * `test(…)`, `test.concurrent(…)`, `test.each([…])(…)` and ``test.each`…`(…)``.
 *
 * This is what tells a test opener from `RegExp.prototype.test`: in
 * `/re/.test(x)` the chain roots at the regex literal and in `matcher.test(x)`
 * at `matcher`, so neither is an `Identifier` named `test`.
 */
function calleeRoot(node) {
  let current = node;
  for (;;) {
    if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "CallExpression") current = current.callee;
    else if (current.type === "TaggedTemplateExpression") current = current.tag;
    else if (current.type === "TSNonNullExpression") current = current.expression;
    else return current;
  }
}

/** Whether `node` is a call whose callee chains from one of `names`. */
function callRootedIn(node, names) {
  if (node.type !== "CallExpression") return false;
  const root = calleeRoot(node.callee);
  return root.type === "Identifier" && names.has(root.name);
}

/** Whether anything under `call` asserts. Includes nested bodies, as before. */
function assertsSomewhere(call) {
  let found = false;
  walk(call, (node) => {
    if (found) return false;
    if (callRootedIn(node, ASSERTERS)) found = true;
  });
  return found;
}

/**
 * The test's name, from the ORIGINAL source.
 *
 * A template title (`` test.each(…)(`case ${n}`, …) ``) is reported raw rather
 * than evaluated — the point is to name the offender in a way the reader can
 * search for, and the substitution's text is what they would search.
 */
function titleOf(call, source) {
  const first = call.arguments[0];
  if (first === undefined) return "(untitled)";
  if (first.type === "Literal" && typeof first.value === "string") return first.value;
  if (first.type === "TemplateLiteral") return source.slice(first.start + 1, first.end - 1);
  return "(untitled)";
}

/**
 * Every test call in one source file.
 *
 * Returns `errors` rather than throwing so the caller decides: a file that will
 * not parse must be LOUD, since silently skipping it is the same shape as the
 * bug this gate exists to catch — something green that checked nothing.
 *
 * @param {string} filename - Used only to pick the dialect (`.ts` vs `.tsx`).
 * @param {string} source
 * @returns {{ tests: { line: number, title: string, asserts: boolean }[], errors: string[] }}
 */
export function findTests(filename, source) {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length > 0) {
    return { tests: [], errors: parsed.errors.map((e) => e.message) };
  }
  const { lineAt } = lineIndexOf(source);
  const tests = [];
  walk(parsed.program, (node) => {
    if (!callRootedIn(node, TEST_NAMES)) return;
    tests.push({
      line: lineAt(node.start),
      title: titleOf(node, source).replace(/\s+/g, " "),
      asserts: assertsSomewhere(node),
    });
    // Do not descend: a `test()` a helper defines inside another belongs to the
    // outer one, which is the count the regex version produced too.
    return false;
  });
  return { tests, errors: [] };
}
