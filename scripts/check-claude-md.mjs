#!/usr/bin/env node

/**
 * Agent-guide size gate, in two tiers.
 *
 * Usage:
 *   node scripts/check-claude-md.mjs            # verify
 *   node scripts/check-claude-md.mjs --update   # lower/remove baseline entries to match the tree
 *
 * - **Auto-loaded** guides — the root `AGENTS.md`, every `CLAUDE.md` in a
 *   package (root or nested directory) and `docs/CLAUDE.md` — are capped at
 *   {@link MAX_AUTO_CHARS}. Claude Code loads these without being asked, so
 *   every task in that directory pays for all of them before reading code.
 * - **Reference** files — `*-CLAUDE.md` siblings, `.agents/*.md`, and the
 *   scaffold and template `CLAUDE.md`s (product artifacts, not auto-loaded repo
 *   docs) — keep {@link MAX_REFERENCE_CHARS}, 20% under the ~150k point past
 *   which an agent's read silently drops the rest.
 *
 * An auto-loaded guide still over its cap is listed in
 * `scripts/claude-md-baseline.json` at its recorded size. The baseline is
 * shrink-only: a listed file fails when it grows past its entry AND when it
 * shrinks below it (so the gain is locked in), an entry for a missing file
 * fails, and `--update` only ever lowers or removes entries — never raises one
 * or adds a file, so an increase is a hand edit in a reviewable diff.
 *
 * The root `CLAUDE.md` is pinned to `@AGENTS.md` rather than measured: content
 * pasted there would be read by Claude Code and no other tool.
 *
 * Paired with `packages/aai-gates/src/claude-md-limit.test.ts`, which reads the
 * same baseline and asserts both caps match the ones here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { compareNames, repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);
const BASELINE = "scripts/claude-md-baseline.json";

/** Cap for a guide Claude Code loads unasked. */
const MAX_AUTO_CHARS = 40_000;
/** Cap for a file read on demand: 20% under the ~150k truncation point. */
const MAX_REFERENCE_CHARS = 120_000;
/** A file at or past this fraction of its cap is reported as nearly full. */
const WARN_RATIO = 0.9;

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { update: { type: "boolean" } },
});

/** Product artifacts: shipped to users, never auto-loaded as repo docs. */
const PRODUCT = /^packages\/aai-templates\/(scaffold|templates)\//;

/**
 * `auto` for a guide Claude Code loads unasked, else `reference`.
 *
 * Decided by name: any `CLAUDE.md` outside the product trees is auto-loaded in
 * its directory, wherever it sits, so a new nested guide gets the tight cap
 * without this list learning about it.
 */
function tierOf(path) {
  if (path === "AGENTS.md") return "auto";
  if (/(^|\/)CLAUDE\.md$/.test(path) && !PRODUCT.test(path)) return "auto";
  return "reference";
}

// `*` in a pathspec crosses `/`, so `*CLAUDE.md` finds nested guides too.
// `--others --exclude-standard` catches a new, unstaged guide; the Set dedupes
// the per-stage rows `--cached` prints during a conflicted merge.
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
        ".agents/*.md",
      ],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((path) => !path.includes("node_modules/"))
      // A tracked file deleted in the working tree is not a guide any more.
      .filter((path) => existsSync(join(ROOT, path))),
  ),
].sort();

if (files.length === 0) {
  console.error("check-claude-md: found no guide files — is the glob still right?");
  process.exit(1);
}

const ROOT_SHIM = "CLAUDE.md";
const ROOT_GUIDE = "AGENTS.md";
if (files.includes(ROOT_SHIM)) {
  const shim = readFileSync(join(ROOT, ROOT_SHIM), "utf8").trim();
  if (shim !== `@${ROOT_GUIDE}`) {
    console.error(
      `\ncheck-claude-md: ${ROOT_SHIM} must contain exactly "@${ROOT_GUIDE}" and nothing else.\n` +
        `Put the content in ${ROOT_GUIDE}, which ${ROOT_SHIM} imports.\n`,
    );
    process.exit(1);
  }
}

/** @type {{ _description?: string, guides?: Record<string, number> }} */
const baselineFile = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8"));
const baseline = baselineFile.guides ?? {};

const num = (n) => n.toLocaleString("en-US");

const guides = files
  .filter((path) => path !== ROOT_SHIM)
  .map((path) => {
    const size = readFileSync(join(ROOT, path), "utf8").length;
    const tier = tierOf(path);
    const cap = tier === "auto" ? MAX_AUTO_CHARS : MAX_REFERENCE_CHARS;
    const recorded = tier === "auto" ? baseline[path] : undefined;
    return { path, size, tier, cap, recorded, limit: recorded ?? cap };
  });
const byPath = new Map(guides.map((g) => [g.path, g]));

/** A guide's `##` sections, largest first — the remedy is a choice of section. */
function topSections(text, limit = 5) {
  return text
    .split(/\n(?=## )/)
    .map((body) => ({
      title: (body.split("\n", 1)[0] ?? "").replace(/^#+ /, "").trim() || "(preamble)",
      size: body.length,
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);
}

function sectionReport(path) {
  const text = readFileSync(join(ROOT, path), "utf8");
  const lines = [`    where ${path}'s characters are:`];
  for (const { title, size } of topSections(text)) {
    const pct = Math.round((size / text.length) * 100);
    lines.push(`      ${num(size).padStart(7)}  ${String(pct).padStart(3)}%  ${title}`);
  }
  return lines.join("\n");
}

// --- Baseline problems: entries that name no auto-loaded guide, or exceed the
// reference cap (a hand-raised entry cannot buy past the truncation margin).
const baselineErrors = [];
for (const [path, recorded] of Object.entries(baseline)) {
  const guide = byPath.get(path);
  if (guide === undefined) {
    baselineErrors.push(`${path}: baselined but no such guide exists (stale entry)`);
  } else if (guide.tier !== "auto") {
    baselineErrors.push(`${path}: baselined but is a reference file, capped at ${num(guide.cap)}`);
  } else if (!Number.isInteger(recorded) || recorded > MAX_REFERENCE_CHARS) {
    baselineErrors.push(
      `${path}: entry ${recorded} is not an integer ≤ ${num(MAX_REFERENCE_CHARS)}`,
    );
  }
}

if (FLAGS.update === true) {
  /** @type {Record<string, number>} */
  const next = {};
  const refused = [];
  for (const [path, recorded] of Object.entries(baseline)) {
    const guide = byPath.get(path);
    if (guide === undefined || guide.tier !== "auto") continue; // stale → removed
    if (guide.size <= MAX_AUTO_CHARS) continue; // under the cap → removed
    if (guide.size > recorded) refused.push(guide);
    next[path] = Math.min(recorded, guide.size);
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => compareNames(a, b)));
  const out = { ...baselineFile, guides: sorted };
  writeFileSync(join(ROOT, BASELINE), `${JSON.stringify(out, null, 2)}\n`);
  const removed = Object.keys(baseline).filter((p) => !(p in sorted));
  const lowered = Object.keys(sorted).filter((p) => (sorted[p] ?? 0) < (baseline[p] ?? 0));
  console.log(
    `check-claude-md: ${BASELINE} updated — ${lowered.length} lowered, ${removed.length} removed.`,
  );
  const unlisted = guides.filter(
    (g) => g.tier === "auto" && g.recorded === undefined && g.size > MAX_AUTO_CHARS,
  );
  if (refused.length > 0 || unlisted.length > 0) {
    for (const g of refused) {
      console.error(`  ${g.path} grew to ${num(g.size)} past its entry — --update never raises`);
    }
    for (const g of unlisted) {
      console.error(
        `  ${g.path} is ${num(g.size)}, over ${num(MAX_AUTO_CHARS)} and unlisted — --update never adds`,
      );
    }
    process.exit(1);
  }
  process.exit(0);
}

const violations = guides.filter((g) => g.size > g.limit);
const slack = guides.filter((g) => g.recorded !== undefined && g.size < g.recorded);
const nearlyFull = guides
  .filter((g) => g.recorded === undefined && g.size <= g.cap && g.size >= g.cap * WARN_RATIO)
  .sort((a, b) => b.size / b.cap - a.size / a.cap);

const widest = Math.max(...guides.map((g) => g.path.length));
for (const { path, size, tier, limit, recorded } of guides) {
  const note = recorded === undefined ? "" : "  (baselined)";
  console.log(
    `  ${path.padEnd(widest)}  ${tier.padEnd(9)}  ${num(size).padStart(8)} / ${num(limit).padStart(7)}${note}`,
  );
}

const REMEDY =
  "Move a section into the CLAUDE.md of the directory whose files it governs\n" +
  "(or into a *-CLAUDE.md sibling / .agents/ file if it is reference), leave a\n" +
  'pointer, and cut history — see AGENTS.md, "Updating agent guides". The scaffold\n' +
  "guide ships to users and has to be cut instead.\n";

let failed = false;
if (baselineErrors.length > 0) {
  failed = true;
  console.error(`\ncheck-claude-md: ${BASELINE} is invalid:`);
  for (const line of baselineErrors) console.error(`  ${line}`);
  console.error("Run `pnpm claude-md:update` to drop stale entries.");
}
if (violations.length > 0) {
  failed = true;
  console.error(`\ncheck-claude-md: ${violations.length} file(s) over their limit:\n`);
  for (const g of violations) {
    const why =
      g.recorded === undefined
        ? `the ${g.tier}-tier cap of ${num(g.cap)}`
        : `its baseline of ${num(g.recorded)} (shrink-only; ${BASELINE})`;
    console.error(`  ${g.path} — ${num(g.size)} chars, over ${why}`);
    console.error(sectionReport(g.path));
  }
  console.error(`\n${REMEDY}`);
}
if (slack.length > 0) {
  failed = true;
  console.error(`\ncheck-claude-md: ${slack.length} baselined guide(s) shrank — lock the gain in:`);
  for (const g of slack) {
    console.error(`  ${g.path} — ${num(g.size)} chars, baseline ${num(g.recorded ?? 0)}`);
  }
  console.error("Run `pnpm claude-md:update` and commit the lowered baseline.");
}
if (failed) process.exit(1);

console.log(
  `\ncheck-claude-md: ${guides.length} file(s) within limits ` +
    `(auto-loaded ${num(MAX_AUTO_CHARS)}, reference ${num(MAX_REFERENCE_CHARS)}, ` +
    `${Object.keys(baseline).length} baselined).`,
);

// Advisory: the author who trips a cap is rarely the one who filled it, so
// announce the split while there is still room to plan it.
if (nearlyFull.length > 0) {
  console.warn(
    `\ncheck-claude-md: ${nearlyFull.length} file(s) past ${Math.round(WARN_RATIO * 100)}% of their cap — ` +
      "split before adding more:\n",
  );
  for (const g of nearlyFull) {
    console.warn(
      `  ${g.path} — ${num(g.size)} chars, ${num(g.cap - g.size)} left of ${num(g.cap)}`,
    );
    console.warn(sectionReport(g.path));
  }
  console.warn(`\n${REMEDY}`);
}
