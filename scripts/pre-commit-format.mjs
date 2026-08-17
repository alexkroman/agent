#!/usr/bin/env node

/**
 * Format staged files with Biome WITHOUT dragging unstaged work into the commit.
 *
 * The hook this replaces was one line in `lefthook.yml`:
 *
 *     biome check --write {staged_files} && git add {staged_files}
 *
 * Biome rewrites the WORKING TREE file, so on a PARTIALLY staged file — some
 * hunks staged, the rest still only in the working tree — the `git add` that
 * follows stages the whole file, and the unstaged hunks land in a commit the
 * author never chose to put them in. Reproduced on a scratch repo before this
 * script existed: one staged line plus one unstaged line, and the unstaged line
 * was in the index afterwards.
 *
 *     staged BEFORE:  const a=1 / const b   =2
 *     staged AFTER:   const a = 1; / const b = 2; / const SECRET_UNSTAGED = 3;
 *
 * That is the whole failure and it is silent: the commit succeeds, the diff the
 * author reviewed is not the diff they pushed, and `git commit -p` / `git add
 * -p` — the two workflows whose entire point is committing a subset — are
 * exactly the ones that produce it.
 *
 * So a partially-staged file is SKIPPED rather than formatted. Skipping is the
 * conservative half: an unformatted file reaches CI and `pnpm check` fails
 * loudly, where the alternative rewrites history the author cannot see. The
 * skip is announced, because a silent one would read as "biome found nothing".
 *
 * An intent-to-add file (`git add -N`) is skipped for the same reason and not
 * by accident: its index entry is empty, so `git diff` reports the whole file
 * as unstaged and there is no staged content for formatting to preserve.
 *
 * Nothing here re-implements the glob — `lefthook.yml` passes `{staged_files}`
 * already filtered, and this script only decides which of them are safe to
 * touch.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BIOME_ARGS = ["biome", "check", "--write", "--no-errors-on-unmatched"];

/** Run a command from the repo root, inheriting stdio for anything the user should see. */
function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

/**
 * Paths with working-tree changes that are NOT in the index.
 *
 * `-z` because a path may contain a newline, and git quotes such a path in the
 * default output — a quoted path would not compare equal to the argv entry
 * lefthook passed, so the file would silently look fully staged and be
 * formatted. That is the same class of bug this script exists to prevent.
 */
function unstagedPaths() {
  const result = run("git", ["diff", "--name-only", "-z"], { capture: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "git diff failed\n");
    process.exit(result.status ?? 1);
  }
  return new Set(result.stdout.split("\0").filter(Boolean));
}

const candidates = process.argv.slice(2).filter((path) => existsSync(path));
if (candidates.length === 0) process.exit(0);

const unstaged = unstagedPaths();
const partial = candidates.filter((path) => unstaged.has(path));
const safe = candidates.filter((path) => !unstaged.has(path));

if (partial.length > 0) {
  process.stderr.write(
    `\npre-commit: skipping ${partial.length} partially-staged file(s) — formatting one\n` +
      "would stage the unstaged hunks along with it:\n\n" +
      partial.map((path) => `  ${path}\n`).join("") +
      "\nStage the rest (`git add <file>`) or format it yourself before committing.\n" +
      "`pnpm check` still enforces the formatting at push time.\n\n",
  );
}

if (safe.length === 0) process.exit(0);

// Biome exits non-zero on a diagnostic it cannot fix. Propagate that: an
// unfixable lint error should block the commit, which is what the `&&` in the
// original one-liner did.
const formatted = run("npx", [...BIOME_ARGS, ...safe]);
if (formatted.status !== 0) process.exit(formatted.status ?? 1);

const staged = run("git", ["add", "--", ...safe]);
process.exit(staged.status ?? 0);
