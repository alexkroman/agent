// Copyright 2026 the AAI authors. MIT license.
/**
 * A PER-FILE coverage floor, because the per-package floors cannot see one file.
 *
 * Each `vitest.config.ts` declares package-wide floors and CI's test matrix
 * gates on them, which catches a package sliding as a whole and is blind to the
 * case that actually happens: one new module lands with almost no tests. The
 * repo has the incident on record — a new ~300-line module in `aai-ui` came in
 * at **1.44% line and 0% branch** coverage, and it was caught only because it
 * happened to drag the whole package under its floor. A larger package, or a
 * smaller module, absorbs that silently: 649 measured files means one file at
 * zero moves a package average by a fraction of a point.
 *
 * So this floors the FILE. Every measured file with at least
 * `MIN_STATEMENTS` statements must cover at least `FLOOR_PCT` of them; files
 * below that today are grandfathered in `coverage-per-file-baseline.json` at
 * their current number, and may improve but never regress.
 *
 * **The ratchet runs the other way from every other one here.** The debt
 * ratchets (`check:hatches`, `check:invariants`) record a count that may only
 * go DOWN, so their `--update` refuses to raise. Coverage is a number that may
 * only go UP, so this `--update` refuses to LOWER — recording an improvement is
 * one command, and blessing a regression needs a hand edit that lands in a
 * reviewable diff. Same contract, mirrored.
 *
 * Two things about what it measures:
 *
 * - **STATEMENTS, not lines.** `coverage-final.json` is istanbul-shaped, and
 *   lines are not in it — istanbul derives them from statements. Statements are
 *   what is actually per-file in the artifact, so they are what this floors;
 *   the per-package floors keep covering lines/functions/branches.
 * - **The measured set is inherited, not re-derived.** Reading each package's
 *   own coverage output means `sharedCoverageExclude`, and every per-package
 *   `exclude` (aai-ui's `contracts/**`, and so on), already applied. A second
 *   copy of that list here is exactly the drift the shared export exists to
 *   prevent.
 *
 * `MIN_STATEMENTS` exists because a 1-statement re-export at 0% is not a
 * finding, and reporting it would be the noise that gets a gate muted rather
 * than fixed. It is stated rather than hidden: files under it are counted and
 * printed in the summary, so the exemption cannot quietly grow.
 *
 * `--seed` and `--update` are deliberately DIFFERENT operations. `--update`
 * only ever touches entries that already exist, so it can refuse to lower one;
 * it will never CREATE an entry. That distinction is the gate's teeth: if
 * `--update` could add entries, a file that fell from 80% to 20% would have no
 * entry to lower and would be silently blessed at 20% — the regression this
 * exists to catch, recorded as if it were the status quo. `--seed` is the
 * one-time bootstrap that introduces the gate over the tree as it stands.
 *
 *   pnpm check:coverage-per-file
 *   node scripts/check-coverage-per-file.mjs --update   # lock in an improvement
 *   node scripts/check-coverage-per-file.mjs --seed     # introduce the gate
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseScriptArgs, requiredValue } from "./_args.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_PATH = path.join(REPO_ROOT, "scripts/coverage-per-file-baseline.json");

/** A file must cover this share of its statements. */
const FLOOR_PCT = 50;
/** Below this many statements a file is not subject to the floor. */
const MIN_STATEMENTS = 10;
/**
 * The corpus floor. Every gate here whose success output is a COUNT carries
 * one, because a scan that stops matching prints the same checkmark as a
 * healthy tree — and this one has an extra way to read empty: coverage that was
 * never run. Measured at 433 files of at least MIN_STATEMENTS statements (649
 * files carry at least one).
 */
const MIN_FILES = 350;

/**
 * `--package <name>` narrows the run to one package, because CI runs
 * `test:coverage` in a MATRIX — one job per package — so a job only ever holds
 * its own coverage output. Without this the gate could run only in
 * `scripts/check.mjs`, which CI never invokes, and it would be enforced by the
 * pre-push hook alone; `git push --no-verify` then skips it entirely. That is the
 * exact gap the quality-ratchet section of AGENTS.md documents.
 *
 * It goes through {@link requiredValue} when present, which is not ceremony: the
 * CI step is `--package "${{ matrix.package }}"`, and an unexpanded matrix
 * variable sends `--package ""` — a legal parse answering the empty string,
 * which selected zero packages, measured nothing, and printed this gate's
 * success line. The old `argv.indexOf` + `argv[i + 1]` reader could not see it,
 * and neither can `parseArgs` alone.
 */
const { values: flags } = parseScriptArgs({
  script: import.meta.url,
  options: {
    update: { type: "boolean" },
    seed: { type: "boolean" },
    package: { type: "string" },
  },
});
const update = flags.update === true;
const seed = flags.seed === true;
const packageArg =
  flags.package === undefined
    ? undefined
    : requiredValue(flags.package, "package", import.meta.url);

/** Packages that produce coverage — derived, never listed. */
function coveragePackages() {
  const dir = path.join(REPO_ROOT, "packages");
  const out = [];
  for (const name of readdirSync(dir)) {
    const manifest = path.join(dir, name, "package.json");
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, "utf-8")).scripts ?? {};
    if (scripts["test:coverage"] === undefined) continue;
    out.push({ name, coverage: path.join(dir, name, "coverage/coverage-final.json") });
  }
  return out;
}

// Refused up front rather than at write time: the baseline is ONE file covering
// every package, and a filtered run's map is built from one package's coverage,
// so writing it would delete every other package's entries — which then reads as
// a clean tree.
if (packageArg !== undefined && (seed || update)) {
  console.error(
    "check-coverage-per-file: --seed/--update rewrite the whole baseline and cannot be\n" +
      "combined with --package. Run `pnpm test:coverage` for every package, then re-run.",
  );
  process.exit(1);
}

let packages = coveragePackages();
if (packageArg !== undefined) {
  const only = packages.filter((p) => p.name === packageArg);
  if (only.length === 0) {
    console.error(
      `check-coverage-per-file: no package "${packageArg}" with a test:coverage script.\n` +
        `Known: ${packages.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }
  packages = only;
}
const missing = packages.filter((p) => !existsSync(p.coverage));
if (missing.length > 0) {
  // Never a skip. A gate that passes because it found no data is the failure
  // shape this repo keeps paying for; `turbo.json` declares `coverage/**` as
  // test:coverage's output, so a cache hit restores it and "missing" really
  // means the task did not run.
  console.error(
    `check-coverage-per-file: no coverage output for ${missing.map((p) => p.name).join(", ")}.\n\n` +
      "This gate reads what `test:coverage` wrote; it cannot measure anything on its own.\n" +
      "Run `pnpm test:coverage` (or `pnpm check`, which runs it first) and try again.",
  );
  process.exit(1);
}

/** @type {{ path: string, pct: number, statements: number }[]} */
const measured = [];
let belowMinStatements = 0;

for (const pkg of packages) {
  const data = JSON.parse(readFileSync(pkg.coverage, "utf-8"));
  for (const [absPath, record] of Object.entries(data)) {
    const counts = Object.values(record.s ?? {});
    if (counts.length === 0) continue;
    const rel = path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
    if (counts.length < MIN_STATEMENTS) {
      belowMinStatements++;
      continue;
    }
    const covered = counts.filter((n) => n > 0).length;
    measured.push({ path: rel, pct: (covered / counts.length) * 100, statements: counts.length });
  }
}

// A filtered run cannot carry the repo-wide corpus floor — `aai-evals` has an
// order of magnitude fewer files than `aai`. It still must not measure NOTHING,
// which is the failure the floor exists to catch; the strong floor applies to the
// unfiltered run that `scripts/check.mjs` makes.
const corpusFloor = packageArg === undefined ? MIN_FILES : 1;
if (measured.length < corpusFloor) {
  console.error(
    `check-coverage-per-file: only ${measured.length} file(s) measured, expected at least ${MIN_FILES}.\n` +
      "Either the coverage output is partial or this script stopped reading it correctly.\n" +
      "A count this low is a broken gate, not a clean tree.",
  );
  process.exit(1);
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) : {};
const allowed = baseline.files ?? {};

/** Floor for one file: its baseline entry, or the global floor. */
const floorFor = (file) => allowed[file] ?? FLOOR_PCT;

const failures = [];
const stale = [];
for (const { path: file, pct, statements } of measured) {
  const floor = floorFor(file);
  // Compare on one decimal place: a v8 counter can wobble in the last digits
  // between runs on the same tree, and a gate that fails on that is a flake.
  const now = Math.floor(pct * 10) / 10;
  if (now < floor) failures.push({ file, now, floor, statements });
  else if (allowed[file] !== undefined && now > floor) stale.push({ file, now, floor });
}

/**
 * Write the baseline, sorted by path so a diff is readable.
 *
 * Refused on a FILTERED run: the baseline is one file covering every package, and
 * a filtered run's `next` map is built from one package's coverage only — writing
 * it would delete every other package's entries, which reads as a clean tree.
 */
function writeBaseline(files) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _description:
          "Per-file statement-coverage floors for files below the global floor — see scripts/check-coverage-per-file.mjs. " +
          "A file may cover MORE than its number and may never cover less; `--update` raises an entry and refuses to lower one, " +
          "and never creates one. Generated: do not hand-edit except to bless a deliberate regression. " +
          `Global floor: ${FLOOR_PCT}% of statements, for files with at least ${MIN_STATEMENTS} statements.`,
        files: Object.fromEntries(
          Object.keys(files)
            .sort()
            .map((k) => [k, files[k]]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

if (seed) {
  // Bootstrap: record every file currently under the global floor at its own
  // number. Existing entries are left alone — seeding is not a way to lower one.
  const next = { ...allowed };
  const added = [];
  for (const { file, now } of failures) {
    if (next[file] !== undefined) continue;
    next[file] = now;
    added.push({ file, now });
  }
  writeBaseline(next);
  console.log(
    `check-coverage-per-file --seed: recorded ${added.length} file(s) under the ${FLOOR_PCT}% floor:\n`,
  );
  for (const { file, now } of added.sort((a, b) => a.now - b.now))
    console.log(`  ${now}%  ${file}`);
  console.log(
    "\nEach is a file nobody has tested to the floor yet. The goal is an empty baseline.",
  );
  process.exit(0);
}

if (update) {
  const next = { ...allowed };
  const raised = [];
  const refused = [];
  for (const { file, now, floor } of stale) {
    next[file] = now;
    raised.push({ file, was: floor, now });
  }
  for (const { file, now, floor } of failures) {
    // `--update` RAISES only. A regression keeps the old number and is refused,
    // so the run still fails and the decision to bless it stays a hand edit.
    refused.push({ file, was: floor, now });
  }
  // A file that climbed above the global floor leaves the baseline entirely.
  for (const file of Object.keys(next)) {
    if (next[file] >= FLOOR_PCT) delete next[file];
  }
  if (refused.length > 0) {
    console.error(
      `check-coverage-per-file --update: refusing to LOWER ${refused.length} entr(ies):\n`,
    );
    for (const { file, was, now } of refused) console.error(`  ${file}  ${was} -> ${now}`);
    console.error(
      "\nCoverage went DOWN for these. Add the tests, or hand-edit the baseline and say why in the PR.",
    );
  }
  if (raised.length > 0) {
    console.log(`check-coverage-per-file --update: raised ${raised.length} entr(ies):\n`);
    for (const { file, was, now } of raised) console.log(`  ${file}  ${was} -> ${now}`);
  } else if (refused.length === 0) {
    console.log("check-coverage-per-file --update: baseline already matches the work tree.");
  }
  writeBaseline(next);
  process.exit(refused.length > 0 ? 1 : 0);
}

if (failures.length > 0) {
  console.error(`check-coverage-per-file: ${failures.length} file(s) under their floor:\n`);
  for (const { file, now, floor, statements } of failures.sort((a, b) => a.now - b.now)) {
    console.error(`  ${file}\n      ${now}% of ${statements} statements, floor ${floor}%`);
  }
  console.error(
    "\nThe per-package floors in each vitest.config.ts cannot see this: one file at zero moves\n" +
      "a package average by a fraction of a point. Add tests for the file, or — if its coverage\n" +
      "genuinely improved and the baseline is behind — run:\n\n" +
      "  node scripts/check-coverage-per-file.mjs --update\n",
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.warn(
    `check-coverage-per-file: ${stale.length} baseline entr(ies) now cover MORE than recorded:\n`,
  );
  for (const { file, now, floor } of stale.slice(0, 20))
    console.warn(`  ${file}  ${floor} -> ${now}`);
  if (stale.length > 20) console.warn(`  … and ${stale.length - 20} more`);
  console.warn(
    "\nRun `node scripts/check-coverage-per-file.mjs --update` to lock the gain in.\n" +
      "Unclaimed headroom is coverage the next branch may give back for free.",
  );
}

const baselined = Object.keys(allowed).length;
console.log(
  `check-coverage-per-file: all ${measured.length} measured file(s) meet their floor ` +
    `(global ${FLOOR_PCT}%, ${baselined} grandfathered). ✓\n` +
    `  ${belowMinStatements} file(s) under ${MIN_STATEMENTS} statements are not subject to the floor.`,
);
