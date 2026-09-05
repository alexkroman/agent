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
 * The one value a single-file glob resolved to.
 *
 * A literal `import.meta.glob` pattern answers a one-entry record keyed by that
 * same literal, so every reader used to write the path TWICE — once for the
 * transform and once to index the result — and a pair that drifted would read
 * `undefined`, i.e. a gate quietly checking an empty string. There are two dozen
 * such reads across this directory; naming the path once is the whole point.
 *
 * Still `T | undefined`: a source that stopped resolving must fail the caller's
 * own `toBeTypeOf("string")` rather than pass as an empty search.
 */
export const sole = <T>(module: Record<string, T>): T | undefined => Object.values(module)[0];

/**
 * The files that decide whether a gate is enforced.
 *
 * A gate named in `package.json` but in neither runner is a script nobody runs;
 * one named only in `scripts/check.mjs` is enforced by the pre-push hook alone,
 * which `git push --no-verify` skips — the repo has been there, for every
 * ratchet at once. So a spec asserts its gate's name appears in both.
 *
 * **`.github/workflows/check.yml` was a third entry, and it is gone because the
 * assertion got STRONGER, not because it was dropped.** CI used to restate the
 * `GATES` table as a shell block of `pnpm run check:*` lines, so "my gate's
 * name appears in check.yml" was the only way to ask whether CI ran it — and
 * the second copy drifted exactly once, fatally: a deleted gate's line survived
 * there, and `pnpm run <missing>` under `bash -e` would have failed the
 * required check on every push. CI now RUNS the table (`node scripts/check.mjs
 * --gates ci`), so a gate name in that file is the DEFECT rather than the
 * evidence. `gate-wiring.test.ts` owns that half now: it asserts every row of
 * the table is enforced by CI, that none is hand-restated as a step, and that
 * every `pnpm run …` still in the workflow names a real root script. Do not add
 * the entry back — it would fail for every gate at once, and asking eight specs
 * to assert a duplicate is what produced the drift.
 *
 * Keyed by repo-relative path so a failure names the file the way a developer
 * would, and typed as possibly-absent so an unreadable source fails the caller's
 * own `toBeTypeOf("string")` rather than passing as an empty search.
 */
export const GATE_WIRING: Record<string, string | undefined> = {
  "package.json": sole(
    import.meta.glob<string>("../../../package.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  "scripts/check.mjs": sole(
    import.meta.glob<string>("../../../scripts/check.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
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
 * shortest form, so the same target arrives under different prefixes depending
 * on which glob found it. This used to enumerate the three shapes it had seen
 * (`../../x` for the repo root, `../pkg/x` for a sibling, `./x` for this
 * package) — which put a *count* of shapes in a helper written precisely
 * because four specs had each forgotten a different one, and the `src/`
 * migration then invalidated all three at once by moving this file a level
 * deeper. Resolving the key properly has no shapes to forget: walk it from this
 * module's own directory the way the runtime would.
 *
 * Hand-rolled rather than `node:path`, because this package's tsconfig declares
 * no node types on purpose — see the header of `konsistent-config.test.ts`.
 */
const HERE = "packages/aai-gates/src";

export const repoPathOf = (key: string): string => {
  const segments = HERE.split("/");
  for (const part of key.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
};

/**
 * Code-unit ordering, spelled out.
 *
 * A bare `.sort()` coerces and compares by UTF-16 code unit anyway, but saying
 * so is the repo's standing rule for anything a gate reads (see the API-surface
 * artifacts): an implicit comparator is one refactor away from `localeCompare`,
 * which answers to the runtime's ICU default and would make a gate report a
 * locale difference as a change.
 *
 * It stood twice under two names — `byCodeUnit` and `compareNames` — which is
 * the shape this module exists for: it is vocabulary, not an assertion, so
 * sharing it costs no gate its own discipline.
 */
export const byCodeUnit = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * A numeric constant read out of a gate script's SOURCE, rather than restated.
 *
 * These specs cannot import the scripts they guard — this package's tsconfig
 * pulls in no node types and the scripts reach `node:` builtins — so a spec that
 * wants to assert a cap reads the declaration as text. Two specs had written the
 * same eight-line reader, differing only in which source it scraped and which
 * filename its error names.
 *
 * It THROWS when the declaration is gone, which is the load-bearing half: a
 * reader answering `NaN` would turn a renamed constant into a comparison nobody
 * can fail.
 */
export const numericConstant = (source: string, name: string, file: string): number => {
  const found = new RegExp(`const ${name} = ([\\d._]+)`).exec(source);
  if (!found?.[1]) throw new Error(`${file} no longer declares ${name}`);
  return Number(found[1].replaceAll("_", ""));
};
