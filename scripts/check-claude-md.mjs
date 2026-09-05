#!/usr/bin/env node

/**
 * Agent-guide size gate.
 *
 * Every guide is loaded into an agent's context in full, and the tool that
 * reads them stops honouring one past ~150k characters — silently, which is
 * the whole problem: nothing warns, the guide is simply half-absent and the
 * agent works from whatever survived. The root file reached 233k that way, one
 * well-justified paragraph at a time.
 *
 * The ROOT guide is `AGENTS.md`; the root `CLAUDE.md` is a one-line
 * `@AGENTS.md` import so both names resolve to one file. Package guides are
 * `CLAUDE.md` (Claude Code auto-loads a package's guide when working in that
 * directory). So the glob covers both names, and the root shim is checked for
 * being a shim rather than measured — an 11-character file passing a 120k cap
 * proves nothing, while a shim that grew back into a second copy of the guide
 * is the actual failure this pattern invites.
 *
 * So the cap here is 20% UNDER that ceiling, leaving room for a section to be
 * added without the next author having to split a file mid-task. The fix when
 * this fails is almost never to delete rationale: move the section into the
 * owning package's `CLAUDE.md` (which Claude Code loads when working in that
 * directory) and leave a pointer, as the root file's "Package guides" table
 * does.
 *
 * `.agents/*.md` is included for the same reason the guides are: those files
 * exist so AGENTS.md can stay small, and an agent reads one whole when it
 * follows the pointer. A cap that stopped at the root would just relocate the
 * problem.
 *
 * `packages/aai-templates/scaffold/CLAUDE.md` is INCLUDED deliberately. It is
 * a product artifact — scaffolded into every `aai init` project and embedded
 * in the studio system prompt — so it is read by an agent in exactly the same
 * way, and it cannot be split at all (a scaffolded project has no packages to
 * push sections into). It is the one file where the answer really is to cut.
 *
 * Wired up as `pnpm check:claude-md`, and paired with
 * `packages/aai-gates/src/claude-md-limit.test.ts`, which asserts the same two
 * lines from the ordinary test run (and that this script's cap still matches
 * the one it checks). Keep MAX_CHARS below in step with the BUDGET there.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);

/** 20% under the 150k limit. */
const MAX_CHARS = 120_000;

/**
 * A guide at or past this fraction of the cap is reported as nearly full.
 *
 * The pass/fail line alone is not enough here, and the reason is specific to
 * how these files grow. A guide gains a paragraph as a SIDE EFFECT of shipping
 * something else — you fixed a subtle thing, you write down why — so the author
 * who trips the cap is never the author who filled it, and the fix (move a
 * section into the owning package's guide, leave a pointer) is a documentation
 * refactor landing inside an unrelated change. Two guides have been at 99-100%
 * for some time; #1058 hit that twice, splitting `aai/CLAUDE.md` at 100% and
 * `aai-server/CLAUDE.md` at 99.9%, both mid-branch and neither related to the
 * feature.
 *
 * So a nearly-full guide is announced while there is still room to plan the
 * split, and every run prints the remaining characters rather than a bare
 * percentage: "1,022 chars left" is a decision, "99% of cap" is a shrug.
 */
const WARN_RATIO = 0.9;

// `--others --exclude-standard` includes new, not-yet-committed files (but not
// gitignored ones), so a freshly-added oversized guide is caught too.
// Deduped: during a conflicted merge or rebase `--cached` lists a path once per
// merge stage, so a conflicted guide would otherwise be read and reported three
// times.
const files = [
  ...new Set(
    execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "*CLAUDE.md",
        "AGENTS.md",
        // The on-demand references AGENTS.md's "Detailed references" table
        // points at. They are read by an agent exactly the way a guide is —
        // whole, into context — so the same cap applies. Leaving them out
        // would move the failure rather than fix it: a section pushed here to
        // get the root under the cap would sit in a file nothing measures.
        ".agents/*.md",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter(Boolean)
      .filter((path) => !path.includes("node_modules/")),
  ),
].sort();

if (files.length === 0) {
  console.error("check-claude-md: found no guide files — is the glob still right?");
  process.exit(1);
}

// The root shim must stay a shim. Both names have to resolve to ONE guide;
// content pasted here would be loaded by Claude Code and by nothing else, so
// the two would diverge with no symptom until an agent using another tool
// worked from the older half.
const ROOT_SHIM = "CLAUDE.md";
const ROOT_GUIDE = "AGENTS.md";
if (files.includes(ROOT_SHIM)) {
  const shim = readFileSync(join(ROOT, ROOT_SHIM), "utf8").trim();
  if (shim !== `@${ROOT_GUIDE}`) {
    console.error(
      `\ncheck-claude-md: ${ROOT_SHIM} must contain exactly "@${ROOT_GUIDE}" and nothing else.\n\n` +
        `The root guide lives in ${ROOT_GUIDE} — the name every agent tool reads. ` +
        `${ROOT_SHIM}\nimports it so Claude Code sees the same file. Put the content in ` +
        `${ROOT_GUIDE}.\n`,
    );
    process.exit(1);
  }
}

const guides = files.map((path) => {
  const size = readFileSync(join(ROOT, path), "utf8").length;
  return { path, size, remaining: MAX_CHARS - size };
});

const violations = guides.filter((g) => g.size > MAX_CHARS);
const nearlyFull = guides
  .filter((g) => g.size <= MAX_CHARS && g.size >= MAX_CHARS * WARN_RATIO)
  .sort((a, b) => a.remaining - b.remaining);

const pct = (size) => Math.round((size / MAX_CHARS) * 100);
const num = (n) => n.toLocaleString("en-US");

const REMEDY =
  "Move a section into the owning package's CLAUDE.md and leave a pointer;\n" +
  'see the root AGENTS.md\'s "Package guides" table and "Updating AGENTS.md".\n' +
  "The scaffold guide is the one that has to be CUT instead — it ships to\n" +
  "users inside every `aai init` project and has no packages to push into.\n";

if (violations.length > 0) {
  console.error(
    `\ncheck-claude-md: ${violations.length} file(s) over the ${num(MAX_CHARS)} char cap:\n`,
  );
  for (const { path, size } of violations) {
    console.error(`  ${path} — ${num(size)} chars (${pct(size)}% of cap)`);
  }
  console.error(`\n${REMEDY}`);
  process.exit(1);
}

const widest = Math.max(...guides.map((g) => g.path.length));
for (const { path, size, remaining } of guides) {
  console.log(
    `  ${path.padEnd(widest)}  ${num(size).padStart(8)} chars  ${String(pct(size)).padStart(3)}%  ` +
      `${num(remaining).padStart(8)} left`,
  );
}
console.log(`\ncheck-claude-md: ${files.length} file(s) within the ${num(MAX_CHARS)} char cap.`);

// A warning, not a failure: the guide is still readable in full, and failing
// here would block the author who merely arrived last. It is loud because the
// alternative is finding out from a gate in the middle of an unrelated change.
if (nearlyFull.length > 0) {
  console.warn(
    `\ncheck-claude-md: ${nearlyFull.length} guide(s) past ${Math.round(WARN_RATIO * 100)}% of the cap — ` +
      "split before adding more:\n",
  );
  for (const { path, size, remaining } of nearlyFull) {
    console.warn(`  ${path} — ${num(size)} chars, only ${num(remaining)} left (${pct(size)}%)`);
  }
  console.warn(`\n${REMEDY}`);
}
