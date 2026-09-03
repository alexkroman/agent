// Copyright 2026 the AAI authors. MIT license.
/**
 * A migration this branch ADDS must sort after every migration already on the
 * base.
 *
 * ## The failure
 *
 * `supabase db push` refuses a pending file whose version is older than the
 * last row in `supabase_migrations.schema_migrations`. The remote list is built
 * with `ORDER BY version` over a TEXT column, so the comparison is
 * lexicographic and the whole question is the filename's leading timestamp.
 *
 * That refusal lands at RELEASE time, in `ship.yml`'s `migrate` job, after the
 * npm publish has already run — and it lands on a branch that is merged and
 * gone, which is the expensive part. It has happened: `aai-server`'s changelog
 * records #1360's `20260902000000` and `20260902010000` sorting BEFORE #1358's
 * `20260902120000`, which production had already applied. Both were re-dated by
 * hand after the fact.
 *
 * Re-dating was the right fix and `--include-all` was rightly refused — that
 * flag applies every pending file regardless of order, which leaves the applied
 * schema a function of MERGE order rather than filename order. This gate is the
 * same answer moved to where the mistake is made.
 *
 * ## Why the mistake is a MERGE hazard, not an authoring one
 *
 * Each branch picks a plausible next timestamp against the `main` it can see,
 * both apply cleanly in isolation, and the inversion exists only in the merge —
 * exactly the shape `platform-schema.test.ts` records for version COLLISIONS,
 * which it catches and this does not (two files claiming one version abort
 * `supabase start`; one file claiming an older version does not).
 *
 * It is likelier here than in most repositories, because `migrate` fires on a
 * RELEASE rather than on a merge: migrations queue up between releases, so two
 * branches routinely pick against the same visible `main`.
 *
 * ## What it can and cannot claim
 *
 * The tree cannot know what production has applied, so the base's migration set
 * is the proxy: anything on `main` may already be applied, and nothing this
 * branch adds may sort before it. Two things make that proxy tight rather than
 * hopeful — the pre-push hook already blocks a push from a branch that is
 * BEHIND `origin/main`, so the base a developer is measured against is current;
 * and `check.yml` checks out at `fetch-depth: 0` on a `pull_request` whose base
 * IS `origin/main`.
 *
 * What it does not catch is a migration that was applied to production and then
 * DELETED from the tree; `schema-drift.scenario.test.ts` is the arm for facts
 * about a real database, and this one is deliberately static.
 *
 * ## Diff-scoped, like `check-deploy-changeset.mjs` and for the same reason
 *
 * `AGENTS.md` records why no ratchet resolves a git ref: one printed "skipping
 * ratchet" and exited 0 wherever `origin/main` was absent. What generalizes is
 * not "never resolve a ref" but "never report success over a comparison you
 * could not make", so an unresolvable base FAILS here, naming `--base`.
 */

import { existsSync } from "node:fs";
import { parseScriptArgs } from "./_args.mjs";
import { SCHEMA_DIR } from "./_deploy-changeset-scope.mjs";
import { git } from "./_ratchet.mjs";

/**
 * The floor under the base corpus.
 *
 * This gate's success output is a pair of counts, so a `SCHEMA_DIR` that
 * matched nothing — moved, renamed, or a `git ls-tree` pathspec that stopped
 * resolving — would find no base migrations, compare every addition against
 * nothing, and print a checkmark. The same argument every corpus floor in
 * `_ratchet.mjs` carries.
 */
const MIN_BASE_MIGRATIONS = 15; // measured: 26

/**
 * A migration filename: 14 digits, an underscore, a descriptive tail.
 *
 * The digit count is load-bearing rather than decorative. Supabase's own CLI
 * has a live bug where 8-digit and 14-digit versions sharing a numeric prefix
 * make `db push` report "Remote migration versions not found in local
 * migrations directory", because the remote comparison is lexicographic over
 * text: `20260903` sorts between `20260902…` and `20260903…` and belongs to
 * neither. Every migration here is 14 digits; requiring it keeps the mixed
 * corpus that triggers that bug unrepresentable.
 */
const MIGRATION_NAME = /^(\d{14})_[^/]+\.sql$/;

/** @param {string} base */
function assertBaseResolves(base) {
  const resolved = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    allowNoMatch: true,
  }).trim();
  if (resolved !== "") return;
  console.error(
    `check-migration-order: cannot resolve "${base}".\n\n` +
      "This gate is diff-scoped, so an unresolvable base is a FAILURE rather than a skip:\n" +
      "a gate that reports success over a comparison it never made is the shape this\n" +
      "repository keeps paying for. Fix it with either of:\n\n" +
      "  git fetch origin main\n" +
      "  node scripts/check-migration-order.mjs --base <ref>\n",
  );
  process.exit(1);
}

/**
 * Just the basenames of the `.sql` files directly under {@link SCHEMA_DIR}.
 *
 * @param {readonly string[]} paths Repo-relative.
 * @returns {string[]}
 */
function migrationNames(paths) {
  const prefix = `${SCHEMA_DIR}/`;
  return paths
    .filter((path) => path.startsWith(prefix) && path.endsWith(".sql"))
    .map((path) => path.slice(prefix.length))
    .filter((name) => !name.includes("/"));
}

/**
 * The migrations the base commit carries.
 *
 * `git ls-tree` rather than `git show`/`git diff`: it names the files at that
 * commit outright, with no dependence on what the branch did to them.
 *
 * @param {string} mergeBase
 * @returns {string[]}
 */
function baseMigrations(mergeBase) {
  const listed = git(["ls-tree", "-r", "--name-only", mergeBase, "--", SCHEMA_DIR], {
    allowNoMatch: true,
  });
  return migrationNames(listed.split("\n").filter(Boolean));
}

/**
 * The migrations the WORKING TREE carries, untracked files included.
 *
 * Untracked is the case that matters: a brand-new migration is invisible to
 * `git diff` and is precisely what this gate is about, so `pnpm check` has to
 * see it before it is ever committed.
 *
 * @returns {string[]}
 */
function treeMigrations() {
  const tracked = git(["ls-files", SCHEMA_DIR], { allowNoMatch: true });
  const untracked = git(["ls-files", "--others", "--exclude-standard", SCHEMA_DIR], {
    allowNoMatch: true,
  });
  const paths = [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
  // A tracked path the branch DELETED is still listed by `ls-files`, and a
  // deletion is not an addition — filter to what is really on disk.
  return migrationNames(paths.filter((path) => existsSync(path)));
}

const { values } = parseScriptArgs({
  script: import.meta.url,
  options: { base: { type: "string" } },
});
// `origin/main` for the reason `check-deploy-changeset.mjs` records: `check.yml`
// runs only on `pull_request: branches: [main]` with `fetch-depth: 0`, and the
// pre-push hook has just fetched it.
const BASE = values.base ?? "origin/main";

assertBaseResolves(BASE);

const mergeBase = git(["merge-base", BASE, "HEAD"]).trim();
const base = baseMigrations(mergeBase);

if (base.length < MIN_BASE_MIGRATIONS) {
  console.error(
    `check-migration-order: ${SCHEMA_DIR} holds ${base.length} migration(s) at the base, ` +
      `under the floor of ${MIN_BASE_MIGRATIONS}.\n\n` +
      "The directory has moved or the pathspec stopped resolving. Fix SCHEMA_DIR in\n" +
      "scripts/_deploy-changeset-scope.mjs — a corpus matching nothing makes this gate\n" +
      "compare every addition against an empty set and print a checkmark.",
  );
  process.exit(1);
}

const tree = treeMigrations();
const baseSet = new Set(base);
const added = tree.filter((name) => !baseSet.has(name)).sort();

/** @type {string[]} */
const malformed = [...base, ...tree].filter((name) => !MIGRATION_NAME.test(name));
if (malformed.length > 0) {
  console.error(
    `check-migration-order: ${malformed.length} migration(s) are not ` +
      "`<14 digits>_<name>.sql`:\n",
  );
  for (const name of [...new Set(malformed)].sort()) console.error(`  ${name}`);
  console.error(
    "\nThe version is the leading timestamp and the remote history compares it as TEXT,\n" +
      "so a version of a different digit length sorts between two 14-digit ones and\n" +
      "belongs to neither — which is a live `db push` bug, not a style rule.",
  );
  process.exit(1);
}

const versionOf = (name) => name.slice(0, 14);
const newestBase = base.map(versionOf).sort().at(-1);
const inverted = added.filter((name) => versionOf(name) <= newestBase);

if (inverted.length === 0) {
  console.log(
    `check-migration-order: ${added.length} added migration(s) sort after all ${base.length} ` +
      `on ${BASE} (newest there: ${newestBase}). ✓`,
  );
} else {
  const newestBaseFile = base.find((name) => versionOf(name) === newestBase);
  console.error("check-migration-order: this branch adds a migration that sorts too early.\n");
  for (const name of inverted) {
    console.error(`  ${name}`);
  }
  console.error(
    `\nThe newest migration on ${BASE} is:\n\n  ${newestBaseFile}\n\n` +
      "Anything on the base may already be applied to production, and `supabase db push`\n" +
      "REFUSES a pending file older than the last remote row — at release time, on a\n" +
      "branch that has merged and gone.\n\n" +
      "Re-date the file(s) above to a timestamp after the one named, keeping the\n" +
      "descriptive tail:\n\n" +
      inverted
        .map((name) => `  git mv ${SCHEMA_DIR}/${name} ${SCHEMA_DIR}/<newer>_${name.slice(15)}`)
        .join("\n") +
      "\n\nDo NOT reach for `--include-all` instead. It applies every pending file whatever\n" +
      "its order, which makes the applied schema a function of merge order rather than\n" +
      "filename order — the reasoning `aai-server`'s changelog records for f376585.",
  );
  process.exit(1);
}
