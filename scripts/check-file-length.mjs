#!/usr/bin/env node

/**
 * Max-file-length gate.
 *
 * Long files are where complexity hides and where reviewers stop reading.
 * This gate caps source and test files at a fixed line count, with a
 * grandfather allowlist (`file-length-allowlist.json`) for the handful of
 * files that already exceed the cap today.
 *
 * The allowlist is a ratchet: each entry records the file's *current*
 * ceiling, and the file may not grow past it. As files get split up the
 * ceilings should be lowered (or entries removed) — never raised. New files
 * have no entry and must come in under the cap from day one.
 *
 * Templates (`packages/aai-templates/templates/`) are exempt: they are
 * self-contained demo agents, not library code, and are already exempt from
 * many lint rules in biome.json.
 *
 * Inspired by the 500-line gate in AssemblyAI/cli's scripts/check.sh.
 *
 * ## It also reports HEADROOM, which is the half that changes behaviour
 *
 * A pass/fail gate tells you about a file you have already grown, and by then
 * the split is a detour: you are deep in a feature, the seam has to be found
 * under time pressure, and the diff that lands mixes a refactor into a change
 * that was about something else. That is not hypothetical here — several
 * branches have carried "moved X into its own module to stay under the cap" as
 * an afterthought commit, and the repo's guides record the splits as forced.
 *
 * The fix is to say it EARLY. Two additions:
 *
 * - Every run prints the files closest to their cap (`--top N`, default 10),
 *   with the lines remaining. On a repo where files sit AT the cap, that is
 *   the difference between planning a split and discovering one.
 * - `--staged` measures only what is staged and never fails, for the
 *   pre-commit hook: it is a nudge while the file is still open, not a gate.
 *   The gate is `pnpm check` at push time.
 *
 * `--json` prints the same measurements as data, for anything that wants to
 * plan against them (a split list, a report) rather than read the table.
 * `packages/aai-gates/src/file-length-gate.test.ts` is the spec for the parts
 * that fail quietly: an advisory report goes nothing-red when it stops
 * selecting files, and a deleted hook line is invisible.
 *
 * Wired up as `pnpm check:file-length`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { readJson, repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);

// Caps. Tests get more headroom — exhaustive cases legitimately run long.
const SOURCE_MAX = 500;
const TEST_MAX = 700;

/**
 * A file at or past this fraction of its cap is reported as approaching it.
 * 0.9 leaves 50 lines of warning on a source file and 70 on a test — roughly
 * one function's worth, which is the scale at which "split this next" is still
 * a cheap decision.
 */
const WARN_RATIO = 0.9;

/**
 * Corpus floor: below this many measured files the run is a FAILURE, not a pass.
 *
 * `git ls-files` exits 0 both for "no matches" and for "that pathspec matched
 * nothing", and the two are indistinguishable from the exit code — so a package
 * rename, a moved directory, or a typo'd glob leaves this gate walking zero
 * files and printing `all files within caps ✓`. That is the silent-zero shape
 * every sibling gate carries a floor against (`check-escape-hatches.mjs` and
 * `guard-invariants.mjs` share one at 800 via `_ratchet.mjs`;
 * `check-test-assertions.mjs` carries its own pair), and this was the one
 * without — the reason `file-length-gate.test.ts` had to assert it from the
 * outside instead.
 *
 * Measured 2026-08: **1222** files after the `/dist/` and template exclusions
 * (1258 `packages/**\/*.ts`, 102 `.tsx`, 38 `scripts/*.mjs`, 1
 * `scripts/**\/*.mjs`; the two `scripts/**\/*.ts` globs are empty by
 * construction and declared as such in that spec). 800 is well under it and is
 * deliberately the same number the siblings use — it is a floor against the
 * corpus VANISHING, not a target, so it should not be tuned to the tree.
 *
 * Not applied in `--staged` mode, which measures the subset one commit touches
 * and is legitimately zero on most commits.
 */
const MIN_CORPUS = 800;

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    staged: { type: "boolean" },
    json: { type: "boolean" },
    all: { type: "boolean" },
    top: { type: "string" },
  },
});
const STAGED = FLAGS.staged === true;
const JSON_OUT = FLAGS.json === true;
const ALL = FLAGS.all === true;
/**
 * `--top` still falls back rather than failing, and that is deliberate: it only
 * chooses how many rows the report PRINTS, so a bad value cannot change the
 * verdict. Every flag that can change a verdict is strict.
 */
const TOP = (() => {
  if (FLAGS.top === undefined) return 10;
  const n = Number(FLAGS.top);
  return Number.isInteger(n) && n > 0 ? n : 10;
})();

let allowlist;
try {
  allowlist = readJson(join(ROOT, "scripts", "file-length-allowlist.json"));
} catch (err) {
  console.error(`check-file-length: ${err.message}`);
  process.exit(1);
}

const isTest = (path) => /\.test\.tsx?$|\.test-d\.ts$|_test-utils\.ts$|test-utils\.ts$/.test(path);
const isExempt = (path) => path.startsWith("packages/aai-templates/templates/");

/** Count lines the way `wc -l` does: one per newline, ignoring a trailing newline. */
const countLines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

const git = (gitArgs) =>
  execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);

/** Only the file kinds this gate measures — the globs below in predicate form. */
const isMeasured = (path) =>
  (/^packages\/.*\.tsx?$/.test(path) || /^scripts\/.*\.(mjs|ts)$/.test(path)) &&
  !path.includes("/dist/") &&
  !isExempt(path);

const listAll = () =>
  // `--others --exclude-standard` includes new, not-yet-committed files (but
  // not gitignored ones) so a freshly-added oversized file is caught too.
  git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "packages/**/*.ts",
    "packages/**/*.tsx",
    // Repo tooling is held to the same cap as shipped source. It is not
    // exempt just because it is not published: `scripts/` is where an
    // unreviewed 900-line harness hides, and two of them were exactly that.
    //
    // BOTH globs are needed, and the top-level one is the one that mattered.
    // A git pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so `*` already crosses
    // `/` and `scripts/**/*.mjs` parses as "scripts/", anything, "/", anything,
    // ".mjs" — the literal slash makes it require a subdirectory. So it matched
    // only the files under `scripts/starter-eval/` and NOT ONE of the ~29 then
    // at the top level, which is exactly where this gate's own comment says the
    // risk is. `packages/**/*.ts` is unaffected because every source file there
    // is at least one directory deep.
    //
    // The nested `.mjs` glob resolves ZERO today — that corpus moved into
    // `packages/aai-evals`, and `scripts/*.mjs` crosses `/` in any case, so it
    // was never the only thing matching those files. Both spellings stay as the
    // guard for the next nested script; `file-length-gate.test.ts` records the
    // empty one in `EMPTY_BY_CONSTRUCTION` so it cannot rot into a silent hole.
    // Verify any of this with `git ls-files "<glob>"`, never by reading it.
    "scripts/*.mjs",
    "scripts/*.ts",
    "scripts/**/*.mjs",
    "scripts/**/*.ts",
  ]).filter((p) => !(p.includes("/dist/") || isExempt(p)));

// Staged-only mode measures what this commit is about to record. `ACM` drops
// deletions and renames-away, which have nothing on disk to measure.
const listStaged = () =>
  git(["diff", "--cached", "--name-only", "--diff-filter=ACM"]).filter(isMeasured);

const files = [...new Set(STAGED ? listStaged() : listAll())].sort();

if (!STAGED && files.length < MIN_CORPUS) {
  console.error(
    `check-file-length: only ${files.length} file(s) matched, under the floor of ${MIN_CORPUS}.\n` +
      "\nThis is not a pass. `git ls-files` exits 0 on a pathspec that matches nothing,\n" +
      "so a renamed package or a typo'd glob makes this gate measure an empty tree and\n" +
      "print a checkmark. Check the pathspecs in `listAll()` with\n" +
      '`git ls-files "<glob>"` — a pathspec is fnmatch WITHOUT FNM_PATHNAME, so\n' +
      "`scripts/**/*.mjs` requires a subdirectory and `scripts/*.mjs` is a separate\n" +
      "entry. If the tree really did shrink this far, lower MIN_CORPUS deliberately.",
  );
  process.exit(1);
}

const violations = [];
const staleAllowlist = [];
const seen = new Set();
/** Every measured file: `{ path, lines, cap, ceiling, remaining }`. */
const measured = [];

for (const path of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, path), "utf8");
  } catch {
    // In the git index but missing from the worktree (e.g. deleted without
    // `git rm` yet) — nothing to measure, so skip rather than crash.
    console.warn(`check-file-length: skipping ${path} (listed by git but not on disk)`);
    continue;
  }
  const lines = countLines(text);
  const cap = isTest(path) ? TEST_MAX : SOURCE_MAX;
  // A grandfathered file's own ceiling is the line it may not cross, so that
  // is the number its headroom is measured against.
  const ceiling = path in allowlist ? allowlist[path] : cap;
  measured.push({ path, lines, cap, ceiling, remaining: ceiling - lines });

  if (path in allowlist) {
    seen.add(path);
    if (lines > ceiling) {
      violations.push(
        `${path}: ${lines} lines exceeds its grandfathered ceiling of ${ceiling}. ` +
          "This file may not grow further — split it up.",
      );
    } else if (lines <= cap) {
      staleAllowlist.push(
        `${path}: now ${lines} lines (under the ${cap}-line cap) — remove it from ` +
          "file-length-allowlist.json.",
      );
    }
    continue;
  }

  if (lines > cap) {
    violations.push(
      `${path}: ${lines} lines exceeds the ${cap}-line cap for ${isTest(path) ? "test" : "source"} files. ` +
        "Split it into focused modules.",
    );
  }
}

// Flag allowlist entries that no longer point at a real file. Skipped in
// staged mode, which measures a SUBSET: an entry for a file this commit does
// not touch is not stale, it is simply not in scope.
if (!STAGED) {
  for (const path of Object.keys(allowlist)) {
    if (path.startsWith("_")) continue;
    if (!seen.has(path)) {
      staleAllowlist.push(
        `${path}: listed in file-length-allowlist.json but not found — remove the stale entry.`,
      );
    }
  }
}

/** Files at or past WARN_RATIO of their own ceiling, tightest headroom first. */
const nearCap = measured
  .filter((m) => m.lines >= Math.floor(m.ceiling * WARN_RATIO) && m.remaining >= 0)
  .sort((a, b) => a.remaining - b.remaining || a.path.localeCompare(b.path));

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        caps: { source: SOURCE_MAX, test: TEST_MAX },
        warnRatio: WARN_RATIO,
        staged: STAGED,
        counts: { measured: measured.length, nearCap: nearCap.length },
        violations,
        staleAllowlist,
        nearCap: ALL ? nearCap : nearCap.slice(0, TOP),
      },
      null,
      2,
    ),
  );
  process.exit(violations.length > 0 || staleAllowlist.length > 0 ? 1 : 0);
}

/**
 * The headroom report. Printed on success as well as failure, because its
 * whole job is to be read BEFORE a file needs splitting: a file with 3 lines
 * left is one that the next feature will have to split, and knowing that at
 * the start of the change is what makes the split land as its own commit.
 */
function reportNearCap() {
  if (nearCap.length === 0) return;
  const shown = ALL ? nearCap : nearCap.slice(0, TOP);
  const pct = (m) => Math.round((m.lines / m.ceiling) * 100);
  const widest = Math.max(...shown.map((m) => m.path.length));
  const scope = STAGED ? "staged file(s)" : "file(s)";
  console.log(
    `\ncheck-file-length: ${nearCap.length} ${scope} within ${Math.round((1 - WARN_RATIO) * 100)}% of the cap:\n`,
  );
  for (const m of shown) {
    const left = m.remaining === 0 ? "AT THE CAP" : `${m.remaining} line(s) left`;
    console.log(
      `  ${m.path.padEnd(widest)}  ${String(m.lines).padStart(4)}/${m.ceiling}  ${String(pct(m)).padStart(3)}%  ${left}`,
    );
  }
  if (!ALL && nearCap.length > shown.length) {
    console.log(`  … and ${nearCap.length - shown.length} more (--all, or --top N)`);
  }
  console.log(
    "\nPlan the split now rather than at the cap: pick the seam the file already\n" +
      "has (a section banner, a leaf type, one exported group) and move it out in\n" +
      "its own commit, before the change that would have forced it.\n",
  );
}

if (violations.length > 0) {
  console.error("check-file-length: file(s) over the line cap:\n");
  for (const v of violations) console.error(`  - ${v}`);
  if (staleAllowlist.length > 0) {
    console.error("\ncheck-file-length: also tidy these allowlist entries:\n");
    for (const s of staleAllowlist) console.error(`  - ${s}`);
  }
  // Staged mode is a nudge, not a gate: it runs on every commit, and blocking
  // a work-in-progress commit teaches `--no-verify`. `pnpm check` at push time
  // is what enforces this.
  if (STAGED) {
    reportNearCap();
    process.exit(0);
  }
  process.exit(1);
}

if (staleAllowlist.length > 0) {
  console.error("check-file-length: stale allowlist entries (ratchet them down):\n");
  for (const s of staleAllowlist) console.error(`  - ${s}`);
  process.exit(1);
}

if (!STAGED) {
  console.log(
    `check-file-length: all files within caps (source ${SOURCE_MAX}, test ${TEST_MAX}). ✓`,
  );
}
reportNearCap();
