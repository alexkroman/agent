// Copyright 2026 the AAI authors. MIT license.
/**
 * A migration that has not been released yet may not CONTRACT the schema under
 * code that has.
 *
 * ## The failure
 *
 * `ship.yml` runs `supabase db push` (job `migrate`) BEFORE the Modal rolling
 * deploy, and Modal keeps the previous build's containers serving until the new
 * ones are healthy. So for the whole rollout — and for good after a red
 * `guest-image`, a failed `deploy`, or a `modal app rollback`, none of which
 * undoes DDL — the PREVIOUSLY RELEASED server runs against the NEW schema.
 * A migration that drops, renames or retypes something that code still names,
 * or tightens a rule that code's inserts do not meet, breaks production at
 * release time, and every check that could have stopped it runs after the
 * schema has already committed.
 *
 * `supabase/README.md` states the rule — **a contraction ships at least one
 * release after the code change that stopped needing the thing it removes** —
 * and until this gate nothing held it: CI applies migrations to an EMPTY
 * database, where every contraction succeeds.
 *
 * ## What it checks
 *
 * 1. **The release.** The newest first-parent ancestor of the merge base that
 *    moved a workspace `package.json` version line — `ship.yml`'s own
 *    definition. Migrations absent from that commit are UNRELEASED: the next
 *    release applies them. The newest such commit that bumped a deploy carrier
 *    (`aai-server` / `aai-studio-server`) is the code that will be SERVING when
 *    they apply.
 * 2. **The contractions.** Every statement in an unreleased migration that
 *    takes something from old readers (drop / rename / retype / move / revoke
 *    from a server role), from old writers (`set not null`, `drop default`, a
 *    new CHECK / UNIQUE / FOREIGN KEY / unique index, a NOT NULL column with no
 *    default) or from old upserts (a dropped unique index).
 * 3. **The references.** The string and template literals of that serving
 *    tree's `packages/<pkg>/src/` (tests, test helpers and `_*-harness.ts`
 *    excluded) — which is where every SQL statement in this codebase lives. A
 *    contraction of something the old code still names FAILS, naming the
 *    migration line and every place the old code names it.
 *
 * `_migration-contract-rules.mjs` holds all three decisions and has the spec;
 * this file is the I/O around them.
 *
 * ## The escape hatch is a reviewed comment, and needs a reason
 *
 *     -- aai:contract-ok the column has been unread since 0.40.0; the one hit is a log label
 *     alter table aai_platform.agents drop column config;
 *
 * On the statement or directly above it. A marker with no reason (fewer than
 * `MIN_REASON_CHARS` characters) is itself a failure: the point is that the
 * claim is written where a reviewer reads the drop.
 *
 * ## Diff-scoped, and never reports success over a comparison it could not make
 *
 * Like `check-migration-order.mjs`: an unresolvable base, a history too shallow
 * to contain a release, or a released tree too small to be the real one FAILS,
 * naming the fix. `check.yml` checks out at `fetch-depth: 0`, so CI meets only
 * the resolvable case.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseScriptArgs } from "./_args.mjs";
import { SCHEMA_DIR } from "./_deploy-changeset-scope.mjs";
import { repoRoot } from "./_fs.mjs";
import {
  addedColumns,
  armsDeploy,
  bumpedPackages,
  CONTRACT_OK_MARKER,
  classifyMigration,
  evaluateFinding,
  isReferenceSource,
  MIN_REASON_CHARS,
  prepareSource,
  uniqueDefinitions,
} from "./_migration-contract-rules.mjs";
import { migrationsAt, treeMigrations } from "./_migration-files.mjs";
import { git } from "./_ratchet.mjs";

const REPO_ROOT = repoRoot(import.meta.url);

/**
 * The floor under the released migration set. A `SCHEMA_DIR` that matched
 * nothing at the release would make EVERY migration "unreleased" — loud, but
 * for the wrong reason — so it fails here with the right one.
 */
const MIN_RELEASED_MIGRATIONS = 15; // measured: 32

/**
 * The floor under the released reference corpus. If the pathspec or
 * {@link isReferenceSource} stopped matching, every contraction would be
 * "referenced nowhere" and pass — this gate's one way to print a checkmark over
 * nothing.
 */
const MIN_REFERENCE_FILES = 400; // measured: 1354

/** How many manifest-touching first-parent commits to walk looking for a release. */
const MAX_RELEASE_SCAN = 400;

/** How many hits to print per finding before summarizing the rest. */
const MAX_HITS_SHOWN = 5;

const { values } = parseScriptArgs({
  script: import.meta.url,
  options: { base: { type: "string" }, release: { type: "string" } },
});
const BASE = values.base ?? "origin/main";

/** @param {string} message */
function fail(message) {
  console.error(`check-migration-contract: ${message}`);
  process.exit(1);
}

/** @param {string} ref @returns {string} The commit sha, or "". */
const resolve = (ref) =>
  git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowNoMatch: true }).trim();

const short = (sha) => sha.slice(0, 10);
const subject = (sha) => git(["log", "-1", "--format=%s", sha]).trim();

/**
 * The release that applied the schema production has, and the release whose
 * server code is serving it.
 *
 * @returns {{ released: string, serving: string }}
 */
function findRelease() {
  if (values.release !== undefined) {
    const sha = resolve(values.release);
    if (sha === "") fail(`cannot resolve --release "${values.release}".`);
    return { released: sha, serving: sha };
  }
  if (resolve(BASE) === "") {
    fail(
      `cannot resolve "${BASE}".\n\n` +
        "This gate is diff-scoped, so an unresolvable base is a FAILURE rather than a skip.\n" +
        "Fix it with either of:\n\n" +
        "  git fetch origin main\n" +
        "  node scripts/check-migration-contract.mjs --base <ref>\n",
    );
  }
  // The MERGE BASE, not HEAD: a Version Packages branch (or its PR's merge
  // commit) moves version lines itself, and counting it as "the release" would
  // excuse exactly the migrations it is about to apply.
  const mergeBase = git(["merge-base", BASE, "HEAD"]).trim();
  const candidates = git([
    "log",
    "--first-parent",
    "--format=%H",
    `--max-count=${MAX_RELEASE_SCAN}`,
    mergeBase,
    "--",
    ":(glob)packages/*/package.json",
  ])
    .split("\n")
    .filter(Boolean);
  let released = "";
  for (const sha of candidates) {
    if (resolve(`${sha}^`) === "") break; // the shallow boundary: no parent to diff against
    const bumped = bumpedPackages(
      git(["diff", `${sha}^`, sha, "--", ":(glob)packages/*/package.json"]),
    );
    if (bumped.size === 0) continue;
    if (released === "") released = sha;
    if (armsDeploy(bumped)) return { released, serving: sha };
  }
  const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  fail(
    `found no ${released === "" ? "release" : "release that deployed the server"} among ` +
      `the first-parent ancestors of ${short(mergeBase)} (${candidates.length} manifest commit(s) read).\n\n` +
      (shallow
        ? "The clone is SHALLOW, so the release is probably just out of reach:\n\n" +
          "  git fetch --unshallow origin main      (or fetch-depth: 0 in CI)\n\n"
        : "") +
      "A gate that cannot find the release cannot say what is unreleased, and passing\n" +
      "anyway is the shape this repository keeps paying for. Name it by hand with:\n\n" +
      "  node scripts/check-migration-contract.mjs --release <sha>\n",
  );
  throw new Error("unreachable");
}

/**
 * The contents of `paths` at `commit`, in one `git cat-file --batch`.
 *
 * @param {string} commit
 * @param {readonly string[]} paths
 * @returns {Map<string, string>}
 */
function readAt(commit, paths) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (paths.length === 0) return out;
  const raw = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input: paths.map((path) => `${commit}:${path}`).join("\n"),
    maxBuffer: 256 * 1024 * 1024,
  });
  let at = 0;
  for (const path of paths) {
    const headerEnd = raw.indexOf(0x0a, at);
    const header = raw.subarray(at, headerEnd).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (header.endsWith("missing") || Number.isNaN(size)) {
      at = headerEnd + 1;
      continue;
    }
    out.set(path, raw.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    at = headerEnd + 1 + size + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------

const { released, serving } = findRelease();
const releasedMigrations = new Set(migrationsAt(released));
if (releasedMigrations.size < MIN_RELEASED_MIGRATIONS) {
  fail(
    `${short(released)} carries ${releasedMigrations.size} migration(s) under ${SCHEMA_DIR}, ` +
      `under the floor of ${MIN_RELEASED_MIGRATIONS}. The directory moved, or the release ` +
      "found is not a real one — pass --release <sha>.",
  );
}

const tree = treeMigrations().sort();
const unreleased = tree.filter((name) => !releasedMigrations.has(name));
const releaseLine =
  `release ${short(released)} ("${subject(released)}")` +
  (serving === released ? "" : `; serving code from ${short(serving)} ("${subject(serving)}")`);

if (unreleased.length === 0) {
  console.log(
    `check-migration-contract: no unreleased migrations (${tree.length} on disk, all in ${releaseLine}). ✓`,
  );
  process.exit(0);
}

const sources = new Map(
  tree.map((name) => [name, readFileSync(`${REPO_ROOT}/${SCHEMA_DIR}/${name}`, "utf8")]),
);
const uniqueDefs = uniqueDefinitions([...sources.values()]);
const newColumns = addedColumns(unreleased.map((name) => sources.get(name) ?? ""));

/** @type {string[]} */
const problems = [];
const pending = unreleased.flatMap((name) => {
  const { findings, markers } = classifyMigration(sources.get(name) ?? "", uniqueDefs);
  for (const marker of markers) {
    if (marker.reason.length < MIN_REASON_CHARS) {
      problems.push(
        `${SCHEMA_DIR}/${name}:${marker.line}  \`${CONTRACT_OK_MARKER}\` without a reason ` +
          `(${MIN_REASON_CHARS}+ characters saying why the old code survives this).`,
      );
    }
  }
  return findings.map((finding) => ({ name, finding }));
});

if (pending.length > 0) {
  const servingPaths = git(["ls-tree", "-r", "--name-only", serving, "--", "packages"])
    .split("\n")
    .filter((path) => isReferenceSource(path));
  if (servingPaths.length < MIN_REFERENCE_FILES) {
    fail(
      `${short(serving)} has ${servingPaths.length} reference source file(s) under packages/*/src, ` +
        `under the floor of ${MIN_REFERENCE_FILES}. The layout moved or isReferenceSource stopped ` +
        "matching — and a corpus matching nothing would pass every contraction.",
    );
  }
  const contents = readAt(serving, servingPaths);
  const corpus = servingPaths.map((path) => prepareSource(path, contents.get(path) ?? ""));

  for (const { name, finding } of pending) {
    const verdict = evaluateFinding(finding, corpus, newColumns);
    const excused = finding.markers.some((marker) => marker.reason.length >= MIN_REASON_CHARS);
    if (!verdict.breaks) continue;
    if (excused) {
      console.log(
        `check-migration-contract: ${SCHEMA_DIR}/${name}:${finding.line} ${finding.action} — ` +
          `excused: "${finding.markers.map((m) => m.reason).join(" / ")}"`,
      );
      continue;
    }
    const shown = verdict.hits
      .slice(0, MAX_HITS_SHOWN)
      .map((hit) => `      ${hit.path}:${hit.line}  ${hit.text}`);
    const more = verdict.hits.length - shown.length;
    problems.push(
      `${SCHEMA_DIR}/${name}:${finding.line}  ${finding.action}\n` +
        `    ${finding.statement.length > 160 ? `${finding.statement.slice(0, 157)}...` : finding.statement}\n` +
        `    but ${verdict.why}:\n${shown.join("\n")}` +
        (more > 0 ? `\n      … and ${more} more` : ""),
    );
  }
}

if (problems.length > 0) {
  console.error(
    `check-migration-contract: ${problems.length} problem(s) in ${unreleased.length} unreleased ` +
      `migration(s), measured against ${releaseLine}.\n`,
  );
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error(
    "`supabase db push` runs BEFORE the rolling deploy, so the code above keeps serving\n" +
      "against this schema for the whole rollout — and for good after a failed deploy or a\n" +
      "`modal app rollback`, neither of which undoes DDL. The rule (supabase/README.md):\n" +
      "a contraction ships at least one release AFTER the code that stopped needing it.\n\n" +
      "  - Move the contraction to a later migration, merged after a release that ships\n" +
      "    the code change (expand → release → contract).\n" +
      "  - Or, if the old code provably survives it, say why on the statement:\n" +
      `      -- ${CONTRACT_OK_MARKER} <reason a reviewer can check>\n`,
  );
  process.exit(1);
}

console.log(
  `check-migration-contract: ${unreleased.length} unreleased migration(s), ${pending.length} ` +
    `contracting statement(s), none breaking ${releaseLine}. ✓`,
);
