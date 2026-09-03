// Copyright 2026 the AAI authors. MIT license.
/**
 * A migration this branch adds must sort AFTER every migration already on the
 * base — because `supabase db push` refuses the whole push otherwise, and that
 * push is the production deploy's `migrate` stage.
 *
 * ## The failure, and that it is not hypothetical
 *
 * Two branches were open at once and merged in the opposite order from their
 * filenames. #1358 landed first carrying
 * `20260902120000_workflow_run_abandonment.sql` and shipped, making that the
 * last row in production's `supabase_migrations.schema_migrations`. #1360 landed
 * 37 minutes later carrying `20260902000000_workflow_step_started_at.sql` and
 * `20260902010000_workflow_run_code_version.sql` — earlier names — and every
 * deploy since failed on:
 *
 *     Found local migration files to be inserted before the last migration on
 *     remote database.
 *     Rerun the command with --include-all flag to apply these migrations: …
 *
 * `deploy` declares `needs: migrate`, so nothing reached production at all.
 * Neither migration was individually wrong and neither PR could see the other:
 * the defect only exists in the pair, which is what makes it a gate's job
 * rather than a reviewer's.
 *
 * ## Why this is not a `supabase db push --dry-run` in CI
 *
 * That is the obvious shape and it CANNOT WORK, which is worth stating in full
 * because it is the design's whole load-bearing claim. Measured against the
 * image `check.yml` already uses (`public.ecr.aws/supabase/postgres:
 * 17.6.1.155`) with the CLI `ship.yml` pins, using `select 1;` migration bodies
 * so only the filenames varied:
 *
 * | remote history | local files | `db push --dry-run` |
 * | -------------- | ----------- | ------------------- |
 * | max `…902120000` | adds `…902000000`, `…902010000` | exit 1, the error above |
 * | max `…902120000` | adds `…902130000`, `…902140000` | exit 0, both pending |
 * | EMPTY (fresh db) | the same broken set | exit 0, all five pending |
 *
 * The third row is the point. `check.yml`'s `platform-stack` job runs
 * `supabase start`, which applies `supabase/migrations` on INIT — so its
 * database holds every migration and a dry-run there has no later row to
 * collide with. The refusal exists only RELATIVE to what production already
 * applied, so a check that does not model that is structurally blind to it, and
 * would print a checkmark on #1360 exactly as every other gate did.
 *
 * Reproduce the table with:
 *
 *     docker run -d --name mig -e POSTGRES_HOST_AUTH_METHOD=trust \
 *       -p 55432:5432 public.ecr.aws/supabase/postgres:17.6.1.155
 *     # apply the pre-#1360 set, then dry-run with the pair added back
 *     supabase db push --db-url \
 *       'postgresql://postgres@127.0.0.1:55432/postgres?sslmode=disable' --dry-run
 *
 * ## What it models instead, and why that needs no database
 *
 * Production's applied maximum is not readable from a pull request — the
 * connection string is a `production` environment secret, and a PR job must not
 * hold it. The honest proxy is **the highest version on the base branch**:
 * everything on `main` is either applied or about to be, so a file that does not
 * clear main's maximum will not clear production's either.
 *
 * And once the comparison is "against main's maximum", no database is involved:
 * the CLI's rule is a comparison of the version PREFIX, which the table above
 * measures directly. That is why this is a pure-git gate in the required check
 * rather than a job with Docker in it — it runs in milliseconds, in the pre-push
 * hook, before the branch is ever pushed.
 *
 * The cost of the proxy is one false negative worth naming: it cannot see that
 * production is CURRENTLY behind, because main's own tree is internally ordered
 * whatever order its files merged in. It prevents the next occurrence; it does
 * not detect the open one. Only a check holding production's history could, and
 * that is `migrate` itself.
 *
 * ## Three rules, and why only one of them is diff-scoped
 *
 * `AGENTS.md` records why gates here are tree-scoped: a ref-resolving ratchet
 * printed "skipping ratchet" and exited 0 in exactly the environments that get
 * one commit of history. Two of these rules need no ref and are absolute —
 * a filename the CLI cannot place, and two files claiming one version. The third
 * is irreducibly about a pair of trees, so it takes the other half of that rule
 * instead: an unresolvable base is a FAILURE naming `--base`, never a skip.
 *
 * Two mechanical notes on the diff:
 *
 *   - **Renames are turned OFF** (`--no-renames`). Git reports a rename as one
 *     `R` entry, which would hide a file renamed BACKWARDS — the exact edit that
 *     fixes this failure is a rename, so the edit that re-creates it is one too.
 *     With renames off it is an `A` plus a `D`, and the `A` is checked.
 *   - **The base is compared at its TIP, the diff at the MERGE BASE.** A branch
 *     cut last week is charged for a migration that landed since, and that is
 *     correct rather than the staleness trap `AGENTS.md` warns about for debt
 *     ratchets: the push really will refuse it, and the remedy — re-date, or
 *     rebase and re-date — is the thing the gate is asking for.
 *
 * Deleting or editing a migration the base already has is a related hazard and
 * deliberately NOT checked here: production has applied it, so a later
 * `supabase start` rebuilds a schema production does not have. It is out of
 * scope because the legitimate case is common enough to need a judgement — the
 * fix for #1360 is itself a rename, i.e. a delete plus an add — and a gate whose
 * first act is to hand out exemptions is not one.
 */

import { parseScriptArgs } from "./_args.mjs";
import {
  byCodeUnit,
  duplicateVersions,
  highestVersion,
  isMigrationPath,
  MIGRATIONS_PREFIX,
  malformedNames,
  nextFreeVersion,
  refusedAdditions,
} from "./_migration-order-scope.mjs";
import { git } from "./_ratchet.mjs";

/**
 * The floor under the corpus.
 *
 * This gate's success output is a COUNT, so a `MIGRATIONS_PREFIX` that had been
 * renamed would enumerate nothing, refuse nothing, and print a checkmark over
 * the hole it exists to close — the shape every floor in `_ratchet.mjs` exists
 * for, and the one `check-gateway-models` shipped without.
 */
const MIN_MIGRATIONS = 20; // measured: 24

/** @param {string} ref @returns {string[]} */
function migrationsIn(ref) {
  return git(["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_PREFIX], {
    allowNoMatch: true,
  })
    .split("\n")
    .filter((path) => isMigrationPath(path));
}

/** Every migration in the WORKING TREE, untracked files included. */
function migrationsInTree() {
  const tracked = git(["ls-files", "--", MIGRATIONS_PREFIX], { allowNoMatch: true });
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", MIGRATIONS_PREFIX], {
    allowNoMatch: true,
  });
  return [...new Set(`${tracked}\n${untracked}`.split("\n"))].filter((path) =>
    isMigrationPath(path),
  );
}

/**
 * The migrations this branch INTRODUCES, working tree and untracked included.
 *
 * Not `git diff base...HEAD`, for the reason `check-deploy-changeset.mjs` gives:
 * that compares two commits, so `pnpm check` over uncommitted work would read an
 * empty diff and print a checkmark. A brand-new migration is exactly the subject
 * here and is invisible to `git diff` until it is added.
 *
 * @param {string} mergeBase
 * @returns {string[]}
 */
function addedSince(mergeBase) {
  const added = git(
    ["diff", "--name-only", "--diff-filter=A", "--no-renames", mergeBase, "--", MIGRATIONS_PREFIX],
    { allowNoMatch: true },
  );
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", MIGRATIONS_PREFIX], {
    allowNoMatch: true,
  });
  return [...new Set(`${added}\n${untracked}`.split("\n"))]
    .filter((path) => isMigrationPath(path))
    .sort(byCodeUnit);
}

/** @param {string} base */
function assertBaseResolves(base) {
  const resolved = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    allowNoMatch: true,
  }).trim();
  if (resolved !== "") return;
  console.error(
    `check-migration-order: cannot resolve "${base}".\n\n` +
      "One of this gate's three rules is diff-scoped, so an unresolvable base is a\n" +
      "FAILURE rather than a skip: a gate that reports success over a comparison it\n" +
      "never made is the shape this repository keeps paying for. Fix it with either of:\n\n" +
      "  git fetch origin main\n" +
      "  node scripts/check-migration-order.mjs --base <ref>\n",
  );
  process.exit(1);
}

/** @param {readonly string[]} tree */
function assertCorpus(tree) {
  if (tree.length >= MIN_MIGRATIONS) return;
  console.error(
    `check-migration-order: found ${tree.length} migration(s) under ${MIGRATIONS_PREFIX}, ` +
      `under the floor of ${MIN_MIGRATIONS}. Either the directory moved or the pathspec is\n` +
      "wrong — a prefix matching nothing makes this gate print a checkmark over every\n" +
      "migration in the repository.",
  );
  process.exit(1);
}

const { values } = parseScriptArgs({
  script: import.meta.url,
  options: { base: { type: "string" } },
});
// Same default and same reasoning as `check-deploy-changeset.mjs`: `check.yml`
// runs on `pull_request: branches: [main]` with `fetch-depth: 0`, so the PR base
// IS `origin/main` there, and the pre-push hook has just fetched it.
const BASE = values.base ?? "origin/main";

const tree = migrationsInTree();
assertCorpus(tree);
assertBaseResolves(BASE);

/** @type {string[]} */
const problems = [];

for (const path of malformedNames(tree)) {
  problems.push(
    `  ${path}\n` +
      "    Not a name `supabase db push` can place. It expects `<14-digit version>_<name>.sql`,\n" +
      "    and orders by that prefix — a 13- or 15-digit stamp sorts somewhere nobody predicted,\n" +
      "    because text order and numeric order agree only at a fixed width.",
  );
}

for (const { version, files } of duplicateVersions(tree)) {
  problems.push(
    `  version ${version} is claimed by ${files.length} files:\n` +
      files.map((file) => `    ${file}`).join("\n") +
      "\n    The history table is keyed by version, so the second is indistinguishable from the\n" +
      "    first having already been applied: it is skipped in silence, on every environment.",
  );
}

const mergeBase = git(["merge-base", BASE, "HEAD"]).trim();
const added = addedSince(mergeBase);
const baseHighest = highestVersion(migrationsIn(BASE));
const refused = refusedAdditions({ added, baseHighest });

if (refused.length > 0 && baseHighest !== null) {
  const suggestion = nextFreeVersion(baseHighest);
  problems.push(
    `  ${refused.length} migration(s) this branch adds do not sort after ${BASE}:\n` +
      refused.map(({ file, version }) => `    ${file} (${version})`).join("\n") +
      `\n    The highest version on ${BASE} is ${baseHighest}, which production has applied or\n` +
      "    is about to. `supabase db push` refuses the WHOLE push when a pending file sorts at\n" +
      "    or before the last row in the remote history table, and the deploy declares\n" +
      "    `needs: migrate` — so this merges and then blocks every release until it is fixed.\n" +
      `    Re-date each one above ${baseHighest}, e.g.:\n\n` +
      `      git mv ${refused[0].file} \\\n` +
      `        ${MIGRATIONS_PREFIX}${suggestion}_${refused[0].file.split("_").slice(1).join("_")}\n\n` +
      "    A migration's timestamp is claimed when it MERGES, not when it is written, so a\n" +
      "    branch that was open while anything newer landed here owes a re-date.",
  );
}

if (problems.length > 0) {
  console.error("check-migration-order: these migrations would break `supabase db push`.\n");
  console.error(problems.join("\n\n"));
  console.error("");
  process.exit(1);
}

console.log(
  `check-migration-order: ${tree.length} migration(s), ${added.length} added against ${BASE} ` +
    `(highest there ${baseHighest ?? "none"}) — names placeable, versions unique, order clear. ✓`,
);
