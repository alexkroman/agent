// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards the HEADROOM half of `scripts/check-file-length.mjs`.
 *
 * The cap itself has never been the expensive part. What costs time is
 * learning about it late: a file already at 500 lines is one the next feature
 * has to split, and a split discovered mid-change lands as an unrelated
 * refactor inside a diff that was about something else. Branches here have
 * carried several of those — "moved X into its own module to stay under the
 * cap" as an afterthought commit, repeatedly, in one branch.
 *
 * So the gate reports what is CLOSE to its cap, and the pre-commit hook prints
 * it for staged files. Both halves fail quietly if they rot: the report is
 * advisory, so nothing goes red when it stops selecting files, and the hook
 * line can be deleted without any test noticing. This suite pins them.
 *
 * Assertions are made against the script's SOURCE, the way
 * `test-assertion-gate.test.ts` and `escape-hatch-scope.test.ts` do: this
 * package's tsconfig has no node types, so a spec here cannot spawn the gate
 * or import its node-builtin-using module — it reads the file that CI runs.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING } from "./_gate-support.ts";

const script = import.meta.glob("../../scripts/check-file-length.mjs", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../scripts/check-file-length.mjs"];

/**
 * The same text, never absent.
 *
 * Every reader below scrapes it, so each one used to spell its own `script ?? ""`
 * — five of them, one of which then indexed `script?.[i]` a character at a time
 * against a length taken from a different expression. The readability of the file
 * is asserted in its own case; the readers work on a string.
 */
const source: string = script ?? "";

const lefthook = import.meta.glob("../../lefthook.yml", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../lefthook.yml"];

/**
 * Every file the gate's pathspecs could plausibly select, repo-relative.
 *
 * Only the KEYS are read, so these are lazy imports nothing ever calls —
 * `guard-invariants-gate.test.ts` builds its `repoFiles` the same way and for
 * the same reason.
 */
const corpus: string[] = [
  ...Object.keys(import.meta.glob("../*/**/*.{ts,tsx}")).map((k) =>
    k.replace(/^\.\.\//, "packages/"),
  ),
  ...Object.keys(import.meta.glob("../../scripts/**/*.{mjs,ts}")).map((k) =>
    k.replace(/^\.\.\/\.\.\//, ""),
  ),
];

/**
 * Pathspecs that resolve to nothing today because the TREE has nothing to
 * match, not because the glob is broken — recorded with the reason, so the
 * distinction is a decision rather than an accident.
 *
 * The gate keeps them because a `.ts` script is a thing somebody will add, and
 * the day they do it must be measured. The assertion below is inverted for
 * these: if one starts matching, this entry is what has gone stale.
 */
const EMPTY_BY_CONSTRUCTION: Record<string, string> = {
  "scripts/*.ts": "no TypeScript sits directly in scripts/ today",
  "scripts/**/*.ts": "no TypeScript sits anywhere under scripts/ today",
};

/**
 * A git pathspec as a regex: fnmatch WITHOUT `FNM_PATHNAME`, which is the whole
 * subtlety — `*` already crosses `/`, so `scripts/**\/*.mjs` is "scripts/",
 * anything, "/", anything, ".mjs" and the literal slash makes a subdirectory
 * MANDATORY. That is exactly the bug this gate shipped with.
 */
const pathspecToRegExp = (spec: string): RegExp =>
  new RegExp(
    `^${spec
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/[*?]/g, (c) => (c === "*" ? "[^]*" : "[^]"))}$`,
  );

/**
 * Code-unit ordering, spelled out.
 *
 * A bare `.sort()` coerces and compares by UTF-16 code unit anyway, but saying
 * so is the repo's standing rule for anything a gate reads (see the API-surface
 * artifacts): an implicit comparator is one refactor away from `localeCompare`,
 * which answers to the runtime's ICU default and would make a gate report a
 * locale difference as a change.
 */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** The pathspecs `listAll()` really hands to `git ls-files`, parsed from source. */
function listAllPathspecs(): string[] {
  const at = source.indexOf("const listAll = () =>");
  if (at === -1) throw new Error("check-file-length.mjs no longer declares listAll");
  const end = source.indexOf("]).filter(", at);
  if (end === -1) throw new Error("check-file-length.mjs: listAll no longer ends in a filter");
  // Comment lines are dropped first: `listAll`'s own comment quotes both the
  // broken glob and a `git ls-files` invocation, so a naive scan reads the
  // gate's prose about pathspecs as pathspecs.
  const code = source
    .slice(at, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return [
    ...new Set([...code.matchAll(/"((?:packages|scripts)\/[^"]*\*[^"]*)"/g)].map((m) => m[1])),
  ]
    .filter((spec): spec is string => spec !== undefined)
    .sort(byCodeUnit);
}

/** Read a numeric constant out of the script rather than restating it here. */
function constant(name: string): number {
  const found = new RegExp(`const ${name} = ([\\d._]+)`).exec(source);
  if (!found?.[1]) throw new Error(`check-file-length.mjs no longer declares ${name}`);
  return Number(found[1].replaceAll("_", ""));
}

/** The body of the first `if (<cond>) {` block whose condition matches. */
function block(opener: string): string {
  const at = source.indexOf(opener);
  if (at === -1) throw new Error(`check-file-length.mjs no longer contains \`${opener}\``);
  const from = at + opener.length;
  let depth = 1;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return source.slice(from, i);
  }
  throw new Error(`check-file-length.mjs: unbalanced braces after \`${opener}\``);
}

describe("check-file-length", () => {
  test("the script is present and declares its caps", () => {
    expect(script, "scripts/check-file-length.mjs not found").toBeTypeOf("string");
    expect(constant("SOURCE_MAX")).toBe(500);
    expect(constant("TEST_MAX")).toBe(700);
  });

  test("the warn ratio leaves a margin worth acting on", () => {
    const ratio = constant("WARN_RATIO");
    // At 1.0 the report only fires once a file is already at the cap, which is
    // the situation it exists to get ahead of; below ~0.75 it names most of the
    // repo and gets skimmed.
    expect(ratio).toBeGreaterThanOrEqual(0.75);
    expect(ratio).toBeLessThan(1);
  });

  test("the near-cap selection is derived from the ratio, not a second number", () => {
    // A hardcoded threshold beside a WARN_RATIO constant is how the constant
    // becomes decorative and the two disagree.
    expect(script).toMatch(/ceiling \* WARN_RATIO/);
  });

  test("headroom is measured against a grandfathered file's own ceiling", () => {
    // A file in the allowlist may not pass ITS ceiling, which is the number it
    // has left — measuring against the 500/700 cap would report an allowlisted
    // 800-line file as 300 lines over budget and never as approaching a limit.
    expect(script).toMatch(/remaining: ceiling - lines/);
    expect(script).toMatch(/const ceiling = path in allowlist \? allowlist\[path\] : cap/);
  });

  test("the scripts pathspec reaches the TOP level, not just subdirectories", () => {
    // A git pathspec is fnmatch without FNM_PATHNAME, so `*` already crosses
    // `/` and `scripts/**/*.mjs` parses as "scripts/" + anything + "/" +
    // anything + ".mjs" — the literal slash makes a subdirectory mandatory. The
    // gate shipped with only that glob, so it measured the six files under
    // scripts/starter-eval/ and none of the ~25 at the top level, which is
    // where its own comment says an unreviewed 900-line harness hides. It
    // printed "all files within caps ✓" throughout.
    // Matched with the quotes, so the prose in the gate's own comment (which
    // names the broken glob in backticks) cannot satisfy these.
    for (const pattern of ['"scripts/*.mjs"', '"scripts/*.ts"']) {
      expect(script, `check-file-length.mjs must measure ${pattern}`).toContain(pattern);
    }
    // The nested globs stay: neither shape subsumes the other.
    expect(script).toContain('"scripts/**/*.mjs"');
    expect(script).toContain('"scripts/**/*.ts"');
    // `packages/**/*.ts` needs no top-level twin — every source file there is
    // at least one directory deep, so the same trap cannot fire.
    expect(script).toContain('"packages/**/*.ts"');
  });

  test("every pathspec the gate scans RESOLVES to files", () => {
    // The assertions above check that pathspec STRINGS appear in the source,
    // which is not the same question and cannot answer it. AGENTS.md's own rule
    // is to verify a pathspec with `git ls-files "<glob>"`, and it was not
    // followed here: two of the five asserted globs resolve to zero files, and
    // this suite could not tell — the same shape as the fnmatch bug above, one
    // level up.
    //
    // The script carries a corpus floor of its own now (`MIN_CORPUS`, pinned by
    // the test below), which catches the case where the WHOLE tree stops
    // resolving. This assertion is the finer-grained half it cannot replace: one
    // dead pathspec among six leaves the total far above any floor, so only a
    // per-spec check can tell "this glob is broken" from "the tree shrank".
    const specs = listAllPathspecs();
    expect(specs.length, "no pathspecs parsed out of listAll()").toBeGreaterThanOrEqual(5);
    expect(corpus.length, "the file corpus is empty").toBeGreaterThan(800);

    for (const spec of specs) {
      const pattern = pathspecToRegExp(spec);
      const matched = corpus.filter((file) => pattern.test(file));
      const emptyReason = EMPTY_BY_CONSTRUCTION[spec];
      if (emptyReason === undefined) {
        expect(
          matched.length,
          `the gate scans "${spec}", which matches no file in the tree — either the ` +
            "glob is wrong or it belongs in EMPTY_BY_CONSTRUCTION with a reason",
        ).toBeGreaterThan(0);
      } else {
        expect(
          matched.length,
          `"${spec}" is recorded as empty by construction (${emptyReason}) but now ` +
            `matches ${matched.length} file(s) — drop the entry, the glob is live`,
        ).toBe(0);
      }
    }
  });

  test("the gate carries a corpus floor of its own", () => {
    // `git ls-files` exits 0 on a pathspec that matches nothing, so a package
    // rename or a typo'd glob leaves the gate walking zero files and printing
    // `all files within caps ✓` — the same silent-zero shape `check:hatches`,
    // `check:invariants` and `check:test-assertions` each carry a floor against,
    // and the one this gate was missing.
    //
    // Pinned here rather than trusted because the floor is itself a thing that
    // can be deleted while every run stays green: it only ever fires on a broken
    // tree, so nothing else would notice its absence.
    expect(
      script,
      "MIN_CORPUS is gone — the gate can print a checkmark over an empty tree",
    ).toMatch(/const MIN_CORPUS = \d+;/);
    expect(script).toContain("files.length < MIN_CORPUS");
    // Not applied to `--staged`, which measures the subset one commit touches
    // and is legitimately zero on most commits.
    expect(script).toContain("!STAGED && files.length < MIN_CORPUS");

    // Read through the same helper the caps use, so the floor cannot be a
    // number this spec invented.
    const declared = constant("MIN_CORPUS");
    expect(declared, "the floor must be a real number, well under the corpus").toBeGreaterThan(0);
    expect(declared).toBeLessThan(corpus.length);
  });

  test("the measured set is not empty, which is what the gate cannot tell you", () => {
    // The same floor from the outside, over an independently-built corpus — so
    // the script agreeing with itself is not what makes this pass.
    const patterns = listAllPathspecs().map(pathspecToRegExp);
    const measured = corpus.filter(
      (file) =>
        patterns.some((p) => p.test(file)) &&
        !file.includes("/dist/") &&
        !file.startsWith("packages/aai-templates/templates/"),
    );
    expect(measured.length, "the gate would measure nothing").toBeGreaterThan(800);
  });

  test("staged mode cannot block a commit", () => {
    // It runs on every commit. A gate there teaches `--no-verify`, which would
    // also skip the pre-push hook that runs the whole check suite.
    expect(block("if (STAGED) {")).toContain("process.exit(0)");
  });

  test("the pre-commit hook prints the staged headroom report", () => {
    expect(lefthook, "lefthook.yml not found").toBeTypeOf("string");
    expect(lefthook).toContain("check-file-length.mjs --staged");
  });

  test("the cap is still enforced by the local check and CI", () => {
    // Same reasoning as claude-md-limit.test.ts: the ratchets once lived only
    // in check.sh, which CI never invokes, so `git push --no-verify` skipped
    // them entirely.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:file-length`).toContain("check:file-length");
    }
  });
});
