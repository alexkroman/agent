#!/usr/bin/env node

/**
 * The agent-guide index, DERIVED from each guide's own frontmatter.
 *
 * Usage:
 *   node scripts/docs-list.mjs           # every guide: path, summary, when to read it
 *   node scripts/docs-list.mjs --json    # the same, for a program
 *   node scripts/docs-list.mjs --write   # regenerate AGENTS.md's three guide tables
 *   node scripts/docs-list.mjs --check   # fail on a missing/malformed header or a stale table
 *
 * `pnpm docs:list` is the cheap way for an agent to find the guide that owns a
 * surface: one line of `summary` and one of `read_when` per guide, instead of
 * opening them. The idea is openclaw's `docs:list`, which does the same over
 * its docs pages.
 *
 * ## Why the tables are generated
 *
 * AGENTS.md indexes 37 guides in three hand-kept tables, and a hand-kept index
 * drifts the way every other hand-kept list in this repo has: the sibling
 * table's own prose said "Fifteen files" over a table of sixteen when this
 * landed, and an earlier pass had found four siblings missing from it
 * altogether. The description now lives IN the guide, as
 *
 *   ---
 *   summary: >-
 *     What the guide covers — the text its table row shows.
 *   read_when: >-
 *     The situation in which an agent should open it.
 *   ---
 *
 * and the rows between each `<!-- guide-index:<group> -->` marker pair in
 * AGENTS.md are written by `--write`. `--check` (a `pnpm check` ratchet) fails
 * when a guide has no header, carries a key other than these two, or when a
 * table no longer matches what `--write` would produce — so a new sibling is
 * indexed by adding its header and running one command.
 *
 * ## What counts as a guide
 *
 * The four shapes `claude-md-limit.test.ts` measures, minus two: the root
 * AGENTS.md (it IS the index) and `scaffold/CLAUDE.md`, which is a product
 * artifact shipped to users as the SDK's `AGENT_GUIDE.md`, not repo docs.
 * Discovery is `git ls-files --cached --others --exclude-standard` filtered by a
 * REGEX rather than a pathspec — a pathspec `*` crosses `/` (AGENTS.md, "A
 * pathspec is fnmatch WITHOUT FNM_PATHNAME"), so `packages/*\/CLAUDE.md` would
 * also match the scaffold's — and includes untracked files, so a guide written
 * a minute ago is checked before it is ever staged.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { isMap, parseDocument } from "yaml";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const GATE = "check:guide-index";
const ROOT = repoRoot(import.meta.url);
const INDEX = "AGENTS.md";
const KEYS = ["summary", "read_when"];

/**
 * The three tables, in the order AGENTS.md shows them. `docs/CLAUDE.md` is a
 * guide the lister reports but no table holds: AGENTS.md introduces it in prose,
 * because it owns three artifacts rather than one package.
 */
const GROUPS = [
  {
    id: "references",
    title: "Detailed references",
    header: "| Reference | Covers |",
    match: /^\.agents\/[^/]+\.md$/,
    cell: (path) => `[\`${path}\`](${path})`,
  },
  {
    id: "packages",
    title: "Package guides",
    header: "| Guide | Covers |",
    match: /^packages\/[^/]+\/CLAUDE\.md$/,
    cell: (path) => `\`${path}\``,
  },
  {
    id: "siblings",
    title: "Sibling guides",
    header: "| Sibling | Covers |",
    match: /^packages\/[^/]+\/[A-Z0-9-]+-CLAUDE\.md$/,
    cell: (path) => `\`${path}\``,
  },
  {
    id: "docs",
    title: "Docs workspace",
    match: /^docs\/CLAUDE\.md$/,
  },
];
/** Measured 2026-09: 37. A broken discovery must not index nothing, green. */
const MIN_GUIDES = 30;

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    json: { type: "boolean" },
    write: { type: "boolean" },
    check: { type: "boolean" },
  },
});

/** Every guide path, repo-relative, sorted by code unit within its group. */
function guidePaths() {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set(listed)]
    .filter((path) => GROUPS.some((group) => group.match.test(path)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The frontmatter of one guide, or the reason it has none usable. A missing
 * FILE (tracked, deleted in the working tree) is not a guide any more.
 */
function readHeader(path) {
  let text;
  try {
    text = readFileSync(join(ROOT, path), "utf8");
  } catch {
    return;
  }
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return { path, problem: "no frontmatter (`---` block on line 1)" };
  // `isMap` on the parsed DOCUMENT rather than a `typeof` check on its value:
  // the parser already knows whether the block is a mapping.
  const doc = parseDocument(match[1] ?? "");
  if (doc.errors.length > 0) {
    return { path, problem: `frontmatter is not YAML: ${doc.errors[0]?.message}` };
  }
  if (!isMap(doc.contents)) return { path, problem: "frontmatter is not a mapping" };
  /** @type {Record<string, unknown>} */
  const data = doc.toJS();
  const extra = Object.keys(data).filter((key) => !KEYS.includes(key));
  if (extra.length > 0) return { path, problem: `unknown key(s): ${extra.join(", ")}` };
  for (const key of KEYS) {
    if (typeof data[key] !== "string" || data[key].trim() === "") {
      return { path, problem: `\`${key}\` is missing or empty` };
    }
  }
  // A table cell cannot hold a newline or a bare pipe.
  const clean = (value) => value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
  return { path, summary: clean(data.summary), readWhen: clean(data.read_when) };
}

const guides = guidePaths()
  .map(readHeader)
  .filter((guide) => guide !== undefined);
const problems = guides.filter((guide) => guide.problem !== undefined);
const groupOf = (path) => GROUPS.find((group) => group.match.test(path));

/** The table rows `--write` puts between a group's markers. */
function renderTable(group) {
  const rows = guides
    .filter((guide) => group.match.test(guide.path))
    .map((guide) => `| ${group.cell(guide.path)} | ${guide.summary} |`);
  return [group.header, "| --- | --- |", ...rows].join("\n");
}

/** AGENTS.md with every marked table regenerated, or a list of missing markers. */
function regenerate(index) {
  let out = index;
  const missing = [];
  for (const group of GROUPS.filter((g) => g.header !== undefined)) {
    const open = `<!-- guide-index:${group.id} -->`;
    const close = `<!-- /guide-index:${group.id} -->`;
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start === -1 || end === -1 || end < start) {
      missing.push(`${open} … ${close}`);
      continue;
    }
    out = `${out.slice(0, start + open.length)}\n${renderTable(group)}\n${out.slice(end)}`;
  }
  return { out, missing };
}

if (FLAGS.check === true || FLAGS.write === true) {
  if (guides.length < MIN_GUIDES) {
    console.error(
      `${GATE}: found ${guides.length} guide(s), under the floor of ${MIN_GUIDES} — ` +
        "the discovery is broken, or guides were deleted (lower MIN_GUIDES with them)",
    );
    process.exit(1);
  }
  if (problems.length > 0) {
    for (const { path, problem } of problems) console.error(`${GATE}: ${path}: ${problem}`);
    console.error(
      `\nEvery guide opens with a frontmatter block carrying exactly ${KEYS.map((k) => `\`${k}\``).join(" and ")} — ` +
        "see the header of scripts/docs-list.mjs.",
    );
    process.exit(1);
  }
  const index = readFileSync(join(ROOT, INDEX), "utf8");
  const { out, missing } = regenerate(index);
  if (missing.length > 0) {
    console.error(`${GATE}: ${INDEX} is missing marker pair(s): ${missing.join("; ")}`);
    process.exit(1);
  }
  if (FLAGS.write === true) {
    if (out !== index) writeFileSync(join(ROOT, INDEX), out);
    console.log(
      `${GATE}: ${INDEX} ${out === index ? "already current" : "regenerated"} — ${guides.length} guide(s)`,
    );
    process.exit(0);
  }
  if (out !== index) {
    console.error(
      `${GATE}: ${INDEX}'s guide tables are stale against the guides' frontmatter. ` +
        "Run `pnpm sync:guide-index` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`${GATE}: ${guides.length} guide(s) carry a header, and ${INDEX}'s tables match ✓`);
  process.exit(0);
}

if (FLAGS.json === true) {
  const rows = guides.map((guide) => ({ ...guide, group: groupOf(guide.path)?.id }));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(problems.length > 0 ? 1 : 0);
}

for (const group of GROUPS) {
  const members = guides.filter((guide) => group.match.test(guide.path));
  if (members.length === 0) continue;
  console.log(`\n${group.title}`);
  for (const guide of members) {
    if (guide.problem !== undefined) {
      console.log(`  ${guide.path}  (${guide.problem})`);
      continue;
    }
    console.log(`  ${guide.path}\n    ${guide.summary}\n    read when: ${guide.readWhen}`);
  }
}
if (problems.length > 0) process.exit(1);
