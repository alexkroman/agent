#!/usr/bin/env node

/**
 * CLAUDE.md size gate.
 *
 * Every `CLAUDE.md` is loaded into an agent's context in full, and the tool
 * that reads them stops honouring one past ~150k characters — silently, which
 * is the whole problem: nothing warns, the guide is simply half-absent and the
 * agent works from whatever survived. The root file reached 233k that way, one
 * well-justified paragraph at a time.
 *
 * So the cap here is 20% UNDER that ceiling, leaving room for a section to be
 * added without the next author having to split a file mid-task. The fix when
 * this fails is almost never to delete rationale: move the section into the
 * owning package's `CLAUDE.md` (which Claude Code loads when working in that
 * directory) and leave a pointer, as the root file's "Package guides" table
 * does.
 *
 * `packages/aai-templates/scaffold/CLAUDE.md` is INCLUDED deliberately. It is
 * a product artifact — scaffolded into every `aai init` project and embedded
 * in the studio system prompt — so it is read by an agent in exactly the same
 * way, and it cannot be split at all (a scaffolded project has no packages to
 * push sections into). It is the one file where the answer really is to cut.
 *
 * Wired up as `pnpm check:claude-md`, and paired with
 * `packages/aai-templates/claude-md-limit.test.ts`, which asserts the same two
 * lines from the ordinary test run (and that this script's cap still matches
 * the one it checks). Keep MAX_CHARS below in step with the BUDGET there.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** 20% under the 150k limit. */
const MAX_CHARS = 120_000;

// `--others --exclude-standard` includes new, not-yet-committed files (but not
// gitignored ones), so a freshly-added oversized guide is caught too.
// Deduped: during a conflicted merge or rebase `--cached` lists a path once per
// merge stage, so a conflicted guide would otherwise be read and reported three
// times.
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*CLAUDE.md"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .filter((path) => !path.includes("node_modules/")),
  ),
].sort();

if (files.length === 0) {
  console.error("check-claude-md: found no CLAUDE.md files — is the glob still right?");
  process.exit(1);
}

const violations = [];
for (const path of files) {
  const size = readFileSync(join(ROOT, path), "utf8").length;
  if (size > MAX_CHARS) violations.push({ path, size });
}

const pct = (size) => Math.round((size / MAX_CHARS) * 100);

if (violations.length > 0) {
  console.error(
    `\ncheck-claude-md: ${violations.length} file(s) over the ${MAX_CHARS} char cap:\n`,
  );
  for (const { path, size } of violations) {
    console.error(`  ${path} — ${size} chars (${pct(size)}% of cap)`);
  }
  console.error(
    "\nMove sections into the owning package's CLAUDE.md and leave a pointer;\n" +
      'see the root CLAUDE.md\'s "Package guides" table and "Updating CLAUDE.md".\n',
  );
  process.exit(1);
}

const widest = Math.max(...files.map((f) => f.length));
for (const path of files) {
  const size = readFileSync(join(ROOT, path), "utf8").length;
  console.log(`  ${path.padEnd(widest)}  ${String(size).padStart(7)} chars  ${pct(size)}% of cap`);
}
console.log(`\ncheck-claude-md: ${files.length} file(s) within the ${MAX_CHARS} char cap.`);
