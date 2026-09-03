// Copyright 2026 the AAI authors. MIT license.
/**
 * A branch that changes code the PLATFORM DEPLOY carries must add a changeset
 * that ships it.
 *
 * ## The hole this closes
 *
 * `.github/workflows/ship.yml` arms its deploy job on a version bump to
 * `aai-server` or `aai-studio-server`, and NOT on a source change — see
 * "A VERSION BUMP is what arms a deploy" there for why that is the right gate.
 * The pre-push hook and `check.yml` both run
 * `pnpm changeset status --since=origin/main`, which asks only whether the
 * changed packages have A changeset. An EMPTY one satisfies it —
 * `pnpm changeset add --empty` is the documented way to say "no release needed"
 * — so a branch may rewrite the platform, pass every gate in the repository,
 * merge, and ship nothing.
 *
 * That is not hypothetical, it is the failure the version gate is accused of
 * causing: #1341 rewrote most of the platform, moved no version line, and
 * reached production only because a Version Packages commit happened to land
 * behind it. The remedy for that is a changeset, and this is the gate that says
 * so at push time rather than leaving it to whoever notices production is a
 * release behind.
 *
 * ## It is STRICTER than the mechanism, deliberately
 *
 * A changeset naming `@alexkroman1/aai` also bumps both server packages, as
 * dependents (`updateInternalDependencies: "patch"`) — verified with
 * `changeset status --output`, where three pending SDK changesets carry
 * `aai-server 3.6.20 -> 3.6.21`. So a branch that changes the SDK and the
 * server would ship anyway, and this gate still asks it to name a carrier.
 *
 * That is the point rather than an oversight. A dependent bump means the server
 * ships because something ELSE is being released; naming a carrier means it
 * ships because the author said it should. #1341 is exactly what the first one
 * looks like when the something-else is a changeset somebody else had queued,
 * so a gate that accepted a transitive bump would have passed it. The strict
 * reading costs one line in a changeset.
 *
 * For the same reason it reads only the changesets THIS BRANCH adds or edits.
 * The pending ones on `main` bump a carrier for any branch that happened to be
 * cut while they sat there, which is the accident and not the remedy.
 *
 * ## There is no opt-out, and no allowlist
 *
 * Same argument as `check:test-assertions`. An entry would assert that some
 * change to shipped platform source rightly reaches no platform, and the only
 * honest version of that claim is "this file does not ship" — which is a
 * statement about the PATH, so it belongs in `isShippedSource`, where it is one
 * rule for every branch, rather than in a per-branch escape.
 *
 * `aai-templates` is deliberately out of scope. It has the same shape (its
 * content reaches a user through the `@alexkroman1/aai-cli` tarball, so an
 * empty changeset ships nothing) by a different mechanism, and the npm path is
 * not what this gate is about. Worth closing; not here.
 *
 * ## The SCHEMA is in scope, and it was the wider half of the hole
 *
 * `supabase/migrations/**` is carried by the deploy too — see `SCHEMA_DIR` in
 * `_deploy-changeset-scope.mjs` for the argument. It is worth naming here
 * because for a migration the failure is strictly worse than for source: an
 * unreleased source change merely does not ship, while an unreleased migration
 * is never APPLIED, and the next release deploys whatever code assumes it. And
 * unlike every package in `CARRIED_PREFIXES`, nothing else could have asked —
 * `changeset status` answers for workspace packages and `supabase/` is not one,
 * so a migration-only branch cleared the pre-push hook as well as this gate.
 *
 * ## Why it is not a `guard-invariants` rule
 *
 * Every rule in that gate is scoped to the TREE, and `AGENTS.md` records why at
 * length: "None of them resolves a git ref any more, and that is deliberate" —
 * a ref-resolving ratchet printed "skipping ratchet" and exited 0 in exactly
 * the environments that get one commit of history, which is this repository's
 * signature failure. This gate is inherently diff-scoped, so it cannot have
 * that property. What it has instead is the other half of that rule: an
 * unresolvable base is a FAILURE naming `--base`, never a skip. Every job in
 * `check.yml` checks out at `fetch-depth: 0` and the pre-push hook has just
 * fetched `origin/main`, so the resolvable case is the only one either caller
 * meets.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseScriptArgs } from "./_args.mjs";
import {
  CARRIED_PREFIXES,
  DEPLOY_CARRIERS,
  namedCarriers,
  SCHEMA_DIR,
  triggeringFiles,
} from "./_deploy-changeset-scope.mjs";
import { git } from "./_ratchet.mjs";
import { parseChangesetFrontmatter } from "./guard-invariants-changesets.mjs";

/**
 * The floor under the corpus.
 *
 * This gate's whole success output is a count, so a `DEPLOY_CARRIED` entry that
 * had been renamed would contribute no paths, match no change, and print a
 * checkmark over the hole it exists to close — the shape every corpus floor in
 * `_ratchet.mjs` exists for. Checked PER PACKAGE rather than in total, so
 * losing one of the four is still a failure.
 */
const MIN_TRACKED_FILES_PER_PACKAGE = 40; // measured: server 287, client 115, guest 91, studio-server 90

/**
 * The floor under the SCHEMA corpus, which is a directory rather than a package
 * and so cannot share the number above.
 *
 * Same argument, one door along: `supabase/migrations` matching nothing — moved,
 * renamed, or a typo in {@link SCHEMA_DIR} — would make every migration-only
 * branch pass, which is the one this entry was added to catch.
 */
const MIN_TRACKED_MIGRATIONS = 15; // measured: 26

/** @param {string} base */
function assertBaseResolves(base) {
  const resolved = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    allowNoMatch: true,
  }).trim();
  if (resolved !== "") return;
  console.error(
    `check-deploy-changeset: cannot resolve "${base}".\n\n` +
      "This gate is diff-scoped, so an unresolvable base is a FAILURE rather than a skip:\n" +
      "a gate that reports success over a comparison it never made is the shape this\n" +
      "repository keeps paying for. Fix it with either of:\n\n" +
      "  git fetch origin main\n" +
      "  node scripts/check-deploy-changeset.mjs --base <ref>\n",
  );
  process.exit(1);
}

function assertCorpus() {
  for (const [key, prefix] of CARRIED_PREFIXES) {
    // The prefix without its trailing slash is the pathspec: `git ls-files`
    // takes a directory, and `packages/aai-server/` and `packages/aai-server`
    // resolve alike, but naming the directory is what the message then prints.
    const dir = prefix.slice(0, -1);
    const tracked = git(["ls-files", dir], { allowNoMatch: true })
      .split("\n")
      .filter(Boolean).length;
    const floor = key === SCHEMA_DIR ? MIN_TRACKED_MIGRATIONS : MIN_TRACKED_FILES_PER_PACKAGE;
    if (tracked >= floor) continue;
    console.error(
      `check-deploy-changeset: ${dir} tracks ${tracked} file(s), under the floor of ` +
        `${floor}. CARRIED_PREFIXES names a directory that has been renamed or removed — ` +
        "fix the table, because a name matching nothing makes this gate print a checkmark " +
        "over the hole it exists to close.",
    );
    process.exit(1);
  }
}

/**
 * Every path this branch has touched since the base, WORKING TREE INCLUDED.
 *
 * Deliberately not `git diff base...HEAD`, which compares two commits: at
 * push time the work is committed and the two agree, but `pnpm check` runs
 * this gate too, and against committed state alone an uncommitted platform
 * change reads as an empty diff and prints a checkmark. So the comparison is
 * the merge-base against the tree, plus untracked files — a brand-new module,
 * and a brand-new changeset, are both invisible to `git diff` and are exactly
 * what this gate is about.
 *
 * @param {string} base
 * @returns {string[]}
 */
function changedSince(base) {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const modified = git(["diff", "--name-only", mergeBase], { allowNoMatch: true });
  const untracked = git(["ls-files", "--others", "--exclude-standard"], { allowNoMatch: true });
  return [...new Set(`${modified}\n${untracked}`.split("\n").filter(Boolean))].sort();
}

/**
 * Does the diff already MOVE a carrier's version?
 *
 * The same predicate as `ship.yml`'s `bumped()`, deliberately — a `+` line
 * touching the `version` field of a carrier's manifest is literally what arms
 * the deploy, so a branch carrying one needs no changeset to promise it.
 *
 * This is not a courtesy arm, it is the one that keeps the Version Packages PR
 * green. That branch DELETES the changesets and writes the version lines, so on
 * the changeset half it looks exactly like the failure this gate reports — the
 * trap `AGENTS.md` already records for the escape-hatch ratchet, which failed a
 * release PR over a `CHANGELOG.md` no human wrote. Reading the mechanism rather
 * than exempting a branch NAME is what makes it structural: nothing has to know
 * what `changeset-release/main` is called.
 *
 * @param {string} base
 * @returns {string[]} The carriers whose version moved.
 */
function versionBumpedCarriers(base) {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  return DEPLOY_CARRIERS.filter((pkg) => {
    const diff = git(["diff", mergeBase, "--", `packages/${pkg}/package.json`], {
      allowNoMatch: true,
    });
    return diff.split("\n").some((line) => /^\+.*"version":/.test(line));
  });
}

/**
 * Every `package: bump` pair the branch's own changesets declare.
 *
 * A file that will not PARSE is reported rather than skipped — silently
 * ignoring it is how a typo'd changeset gets read as an absent one, which is
 * rule 20's whole subject. A file that no longer EXISTS is a different case
 * and is skipped: the diff is against a merge base, so it names deletions as
 * well as additions, and a release consumes changesets by deleting them. Any
 * branch whose merge base predates a Version Packages merge therefore lists
 * files that are gone — which used to crash the whole gate on `readFileSync`,
 * with a bare ENOENT and no mention of what was being checked. A changeset
 * the branch REMOVED ships nothing either way, so there is nothing to read.
 *
 * @param {readonly string[]} changed From {@link changedSince}.
 * @returns {{ entries: {name: string}[], malformed: {file: string, error: string}[] }}
 */
function branchChangesetEntries(changed) {
  const files = changed.filter(
    (path) =>
      path.startsWith(".changeset/") &&
      path.endsWith(".md") &&
      !path.endsWith("README.md") &&
      existsSync(path),
  );
  const entries = [];
  const malformed = [];
  for (const file of files) {
    const parsed = parseChangesetFrontmatter(readFileSync(file, "utf8"));
    if ("error" in parsed) malformed.push({ file, error: parsed.error });
    else entries.push(...parsed.entries);
  }
  return { entries, malformed };
}

/** @param {Map<string, string[]>} triggering @param {{file: string, error: string}[]} malformed */
function reportFailure(triggering, malformed) {
  console.error("check-deploy-changeset: this branch changes code a DEPLOY carries, and");
  console.error("nothing in it makes a deploy happen.\n");
  for (const [key, prefix] of CARRIED_PREFIXES) {
    const bucket = triggering.get(key);
    if (bucket === undefined) continue;
    console.error(`  ${prefix.slice(0, -1)} — ${bucket.length} file(s):`);
    for (const path of bucket.slice(0, 5)) console.error(`    ${path}`);
    if (bucket.length > 5) console.error(`    … and ${bucket.length - 5} more`);
  }
  if (triggering.has(SCHEMA_DIR)) {
    console.error(
      `\n  ${SCHEMA_DIR} is the SCHEMA, and its case is worse than a source change:\n` +
        "  `supabase db push` applies what is PENDING, armed by a carrier version bump and\n" +
        "  nothing else, so an unreleased migration is not merely unshipped — it is never\n" +
        "  APPLIED, and the code that assumes it deploys on some later, unrelated release.\n" +
        "  `changeset status` cannot ask for this: supabase/ is not a workspace package.",
    );
  }
  for (const { file, error } of malformed) {
    console.error(`\n  ${file} could not be parsed: ${error}`);
  }
  console.error(
    "\n`ship.yml` arms its deploy on a VERSION BUMP to a carrier, so an empty changeset\n" +
      "means this merges and ships nothing — the #1341 failure a changeset is the answer\n" +
      "to. Add one:\n\n" +
      `  pnpm changeset:create --pkg ${DEPLOY_CARRIERS[0]} --bump patch --summary "…"\n\n` +
      `Either carrier counts (${DEPLOY_CARRIERS.join(", ")}). Both are private, and\n` +
      "`privatePackages: { version: true }` in .changeset/config.json is what makes naming\n" +
      "one really move a version. A changeset naming only an SDK package bumps them as\n" +
      "DEPENDENTS and is deliberately not enough — see this script's module doc.",
  );
}

const { values } = parseScriptArgs({
  script: import.meta.url,
  options: { base: { type: "string" } },
});
// `origin/main` rather than `GITHUB_BASE_REF`, which would buy nothing and cost
// a turbo declaration: `check.yml` only runs on `pull_request: branches: [main]`
// and every one of its jobs checks out at `fetch-depth: 0`, so the PR base IS
// `origin/main` there — and the pre-push hook has just fetched it. `--base` is
// what covers anything else, out loud.
const BASE = values.base ?? "origin/main";

assertCorpus();
assertBaseResolves(BASE);

const changed = changedSince(BASE);
const triggering = triggeringFiles(changed);
const carried = [...triggering.values()].reduce((sum, files) => sum + files.length, 0);

if (carried === 0) {
  console.log(
    `check-deploy-changeset: no deploy-carried source changed against ${BASE} ` +
      `(${changed.length} changed file(s)). ✓`,
  );
} else {
  const bumped = versionBumpedCarriers(BASE);
  const { entries, malformed } = branchChangesetEntries(changed);
  const named = namedCarriers(entries);
  if (bumped.length > 0) {
    console.log(
      `check-deploy-changeset: ${carried} deploy-carried file(s) changed, shipped by a ` +
        `version bump to ${bumped.join(", ")}. ✓`,
    );
  } else if (named.length > 0) {
    console.log(
      `check-deploy-changeset: ${carried} deploy-carried file(s) changed, shipped by a ` +
        `changeset naming ${named.join(", ")}. ✓`,
    );
  } else {
    reportFailure(triggering, malformed);
    process.exit(1);
  }
}
