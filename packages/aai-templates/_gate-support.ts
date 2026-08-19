// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * What every gate spec in this package needs and none of them owns.
 *
 * The specs beside this file guard the repo-level quality gates, and three
 * things had been copied between them verbatim: the two-and-a-bit shapes a Vite
 * glob key arrives in, the list of regex constructs POSIX ERE has no answer for,
 * and the three files a gate must be NAMED in to be enforced at all. The last
 * one stood five times, seventeen lines each, differing only in the gate name
 * the caller then asserts.
 *
 * Sharing them costs nothing this package cares about, because none of it is an
 * ASSERTION: each spec still makes its own, over its own gate. What moves here
 * is the reading and the vocabulary — and a glob that stopped resolving still
 * fails every caller, since {@link GATE_WIRING}'s values are `undefined` and
 * every caller checks them.
 *
 * `import.meta.glob` is a compile-time transform, so its arguments must be
 * literals at the call site — which is why the sources are read HERE, once, and
 * exported as values. A caller cannot hoist the options object; it can import
 * the result. Keys resolve relative to the globbing file, and every gate spec
 * sits in this same directory, so the shapes below describe theirs too.
 */

/**
 * The files that decide whether a gate is enforced.
 *
 * A gate named in `package.json` but in neither runner is a script nobody runs;
 * one named only in `scripts/check.sh` is enforced by the pre-push hook alone,
 * which `git push --no-verify` skips — the repo has been there, for every
 * ratchet at once. So a spec asserts its gate's name appears in all three.
 *
 * Keyed by repo-relative path so a failure names the file the way a developer
 * would, and typed as possibly-absent so an unreadable source fails the caller's
 * own `toBeTypeOf("string")` rather than passing as an empty search.
 */
export const GATE_WIRING: Record<string, string | undefined> = {
  "package.json": import.meta.glob<string>("../../package.json", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../../package.json"],
  "scripts/check.sh": import.meta.glob<string>("../../scripts/check.sh", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../../scripts/check.sh"],
  ".github/workflows/check.yml": import.meta.glob<string>("../../.github/workflows/check.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../../.github/workflows/check.yml"],
};

/**
 * Regex constructs a pattern must not use, with the reason each is banned.
 *
 * The gates VALIDATE their patterns with JavaScript's `new RegExp` and SHIP them
 * to `git grep -nIE` — POSIX ERE, whose GNU-extension support varies by build.
 * `\b` is the one already paid for: two escape-hatch patterns carried one,
 * matched NOTHING on the machines where git's matcher does not implement it, and
 * the gate reported success over a tree holding 110 violations. A JS-side regex
 * test cannot detect that, so every construct ERE has no answer for is banned
 * outright rather than only the one that has bitten.
 *
 * Both pattern-shipping gates check their own patterns against this — the
 * escape-hatch ratchet and the invariant line rules — which is why the list is
 * one value: a construct added to one copy and not the other is a hole in
 * whichever gate was not updated.
 */
export const ERE_UNSUPPORTED: readonly (readonly [construct: string, why: string])[] = [
  ["\\b", "a word boundary — git's matcher does not implement it"],
  ["\\B", "a non-word-boundary — same GNU extension as \\b"],
  ["\\w", "a GNU character class; POSIX ERE spells it [A-Za-z0-9_]"],
  ["\\d", "a GNU character class; POSIX ERE spells it [0-9]"],
  ["\\s", "a GNU character class; POSIX ERE spells it [[:space:]]"],
  ["(?", "a JS-only group (lookaround or non-capturing); ERE has neither"],
  ["*?", "a lazy quantifier; ERE quantifiers are always greedy"],
  ["+?", "a lazy quantifier; ERE quantifiers are always greedy"],
] as const;

/**
 * A Vite glob key as a repo-relative path, so a failure names the file the way a
 * developer would.
 *
 * Keys resolve relative to the globbing file and Vite collapses them to the
 * shortest form, which from this directory is three shapes: `../../x` is the
 * repo root, `../pkg/x` is a sibling package (one level up from
 * `packages/aai-templates/` is `packages/`), and `./x` is this package — which
 * is the shape a `../PACKAGE/**` glob reports aai-templates' own files under.
 * Four specs had written two or three of those inline; a helper that knows all
 * three cannot be the one that forgot the shape it does not usually see.
 */
export const repoPathOf = (key: string): string => {
  if (key.startsWith("../../")) return key.slice("../../".length);
  if (key.startsWith("../")) return `packages/${key.slice("../".length)}`;
  return `packages/aai-templates/${key.replace(/^\.\//, "")}`;
};
