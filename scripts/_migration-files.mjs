// Copyright 2026 the AAI authors. MIT license.
/**
 * Which migration files exist — on disk, and at a commit — for the two gates
 * that reason about them (`check-migration-order.mjs`,
 * `check-migration-contract.mjs`). One copy, because the two are the same
 * question and a second copy is how they would come to disagree about it.
 */

import { existsSync } from "node:fs";
import { SCHEMA_DIR } from "./_deploy-changeset-scope.mjs";
import { repoRoot } from "./_fs.mjs";
import { git } from "./_ratchet.mjs";

const ROOT = repoRoot(import.meta.url);

/**
 * Just the basenames of the `.sql` files directly under {@link SCHEMA_DIR}.
 *
 * @param {readonly string[]} paths Repo-relative.
 * @returns {string[]}
 */
export function migrationNames(paths) {
  const prefix = `${SCHEMA_DIR}/`;
  return paths
    .filter((path) => path.startsWith(prefix) && path.endsWith(".sql"))
    .map((path) => path.slice(prefix.length))
    .filter((name) => !name.includes("/"));
}

/**
 * The migrations a commit carries.
 *
 * `git ls-tree` rather than `git show`/`git diff`: it names the files at that
 * commit outright, with no dependence on what the branch did to them.
 *
 * @param {string} commit
 * @returns {string[]}
 */
export function migrationsAt(commit) {
  const listed = git(["ls-tree", "-r", "--name-only", commit, "--", SCHEMA_DIR], {
    allowNoMatch: true,
  });
  return migrationNames(listed.split("\n").filter(Boolean));
}

/**
 * The migrations the WORKING TREE carries, untracked files included.
 *
 * Untracked is the case that matters: a brand-new migration is invisible to
 * `git diff` and is precisely what these gates are about, so `pnpm check` has
 * to see it before it is ever committed.
 *
 * @returns {string[]}
 */
export function treeMigrations() {
  const tracked = git(["ls-files", SCHEMA_DIR], { allowNoMatch: true });
  const untracked = git(["ls-files", "--others", "--exclude-standard", SCHEMA_DIR], {
    allowNoMatch: true,
  });
  const paths = [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
  // A tracked path the branch DELETED is still listed by `ls-files`, and a
  // deletion is not an addition — filter to what is really on disk.
  return migrationNames(paths.filter((path) => existsSync(`${ROOT}/${path}`)));
}
