#!/usr/bin/env node

/**
 * Materialize the agent-authoring guide into the `@alexkroman1/aai` tarball,
 * and generate the `@alexkroman1/aai` subpath list the guide and the skill
 * carry.
 *
 * ## The drift this removes
 *
 * The guide is authored in the scaffold (`scripts/_agent-guide.mjs` has the
 * layout: a core `CLAUDE.md` plus topic files in `agent-guide/`). A copy made
 * by `aai init` would be frozen at scaffold time while
 * `pnpm update @alexkroman1/aai` moves the SDK beside it, so the guide ships
 * INSIDE the `aai` package instead — `node_modules/@alexkroman1/aai/AGENT_GUIDE.md`
 * and its `agent-guide/` neighbours cannot describe a different release than
 * the SDK next to them. `layerScaffoldFiles` writes a pointer at that path as a
 * project's `CLAUDE.md`; `packages/aai/skills/aai/SKILL.md` points at it too
 * and carries no API guidance of its own, because a skill has no version.
 *
 * ## Why a repo-level script and not a package dependency
 *
 * `aai` must import no sibling package (AGENTS.md's dependency flow, enforced
 * by `konsistent.json`). This script reads both trees, so neither package
 * declares anything about the other; the copies are committed, and `--check`
 * keeps them honest.
 *
 * ## What `--check` asserts
 *
 * - every copy matches its source plus banner, and the SDK's `agent-guide/`
 *   holds no file the scaffold does not;
 * - the generated subpath block in the core guide and in SKILL.md matches
 *   `packages/aai/package.json` `exports`, and `SUBPATHS` covers that map
 *   exactly;
 * - the root barrel's subpath table (`packages/aai/src/index.ts`) names only
 *   specifiers that resolve;
 * - the core names every topic file and names none that is missing, so the
 *   routing table is total;
 * - the core and each topic stay under their size budgets.
 *
 *   node scripts/sync-agent-guide.mjs           # write the copies and blocks
 *   node scripts/sync-agent-guide.mjs --check   # fail if any is stale
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import {
  CORE_BUDGET,
  CORE_SOURCE,
  guideFiles,
  ROOT,
  renderSubpathBlock,
  SDK_DIR,
  SKILL_PATH,
  SOURCE_DIR,
  specifierOf,
  subpathProblems,
  TOPIC_BUDGET,
  TOPIC_DIR,
  topicFiles,
  withSubpathBlock,
} from "./_agent-guide.mjs";
import { parseCheckFlag } from "./_args.mjs";

const CHECK = parseCheckFlag(import.meta.url);

const rel = (path) => relative(ROOT, path);

/**
 * A banner on each copy, so nobody edits the wrong file. Part of the compared
 * content: without it an edit that removed the banner would leave a copy that
 * looks authored.
 */
const banner = (source) =>
  [
    "<!--",
    "  GENERATED FILE — do not edit.",
    "",
    `  Source: ${rel(source)}`,
    "  Regenerate: node scripts/sync-agent-guide.mjs",
    "",
    "  This copy ships inside the @alexkroman1/aai tarball so an agent working in",
    "  a user's project reads guidance that MATCHES the installed SDK. It is the",
    "  only copy such a project has: `aai init` writes a short pointer at",
    "  AGENT_GUIDE.md as the project's CLAUDE.md rather than a snapshot that goes",
    "  stale on the next `pnpm update`. See packages/aai/skills/aai/SKILL.md.",
    "-->",
    "",
  ].join("\n");

const readOrNull = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

const problems = [];
/** `{ path, expected }` for every file this run would write. */
const writes = [];
/** Paths this run would delete. */
const removals = [];

// 1. The subpath record must describe the exports map exactly; a block
//    rendered from an incomplete record would publish "(undocumented)".
problems.push(...subpathProblems());

// 2. The generated block, in the core source (compact — it has a budget) and
//    in the skill (every subpath described).
/** @type {{ path: string, detail: boolean }[]} */
const BLOCK_FILES = [
  { path: join(SOURCE_DIR, CORE_SOURCE), detail: false },
  { path: SKILL_PATH, detail: true },
];
for (const { path, detail } of BLOCK_FILES) {
  const current = readFileSync(path, "utf8");
  const next = withSubpathBlock(current, renderSubpathBlock(undefined, { detail }));
  if (next === null) {
    problems.push(
      `${rel(path)} has lost its generated subpath block — restore the BEGIN/END GENERATED ` +
        "markers from scripts/_agent-guide.mjs so the list can be written between them.",
    );
  } else if (next !== current) {
    writes.push({ path, expected: next, why: "its subpath list is stale" });
  }
}

// 3. The copies. Read AFTER step 2 so the core's copy carries the fresh block.
const pendingSource = new Map(writes.map((one) => [one.path, one.expected]));
for (const file of guideFiles()) {
  const text = pendingSource.get(file.source) ?? file.text;
  const expected = `${banner(file.source)}${text}`;
  if (readOrNull(file.destination) !== expected) {
    writes.push({ path: file.destination, expected, why: "it is stale or missing" });
  }
}
const topicNames = new Set(topicFiles());
const shippedTopicDir = join(SDK_DIR, TOPIC_DIR);
if (existsSync(shippedTopicDir)) {
  for (const name of readdirSync(shippedTopicDir)) {
    if (!topicNames.has(name)) removals.push(join(shippedTopicDir, name));
  }
}

// 4. The routing table is total: the core names every topic, and only topics
//    that exist.
const core =
  pendingSource.get(join(SOURCE_DIR, CORE_SOURCE)) ??
  readFileSync(join(SOURCE_DIR, CORE_SOURCE), "utf8");
const named = new Set(
  [...core.matchAll(new RegExp(`${TOPIC_DIR}/([A-Z][A-Z0-9-]*\\.md)`, "g"))].map((m) => m[1]),
);
for (const name of topicNames) {
  if (!named.has(name)) {
    problems.push(
      `${rel(join(SOURCE_DIR, CORE_SOURCE))} never names \`${TOPIC_DIR}/${name}\` — add it to ` +
        'the "Read X when Y" routing table, or an agent reading the core will never open it.',
    );
  }
}
for (const name of named) {
  if (!topicNames.has(name)) {
    problems.push(
      `${rel(join(SOURCE_DIR, CORE_SOURCE))} names \`${TOPIC_DIR}/${name}\`, which does not exist.`,
    );
  }
}

// 5. Budgets.
for (const file of guideFiles()) {
  const isCore = basename(file.source) === CORE_SOURCE && dirname(file.source) === SOURCE_DIR;
  const budget = isCore ? CORE_BUDGET : TOPIC_BUDGET;
  // Measured AFTER this run's block rewrite: the budget is about what ships.
  const length = (pendingSource.get(file.source) ?? file.text).length;
  if (length > budget) {
    problems.push(
      `${rel(file.source)} is ${length.toLocaleString("en-US")} chars, over its ` +
        `${budget.toLocaleString("en-US")} budget. ${
          isCore
            ? "The core is what every agent reads first — move a section into a topic file and route to it."
            : "Split the topic, or move what is not on-demand reference into the core."
        }`,
    );
  }
}

// 6. The root barrel's hand-curated subpath table may name only real subpaths.
//    It is a subset by design ("chosen by WHO READS IT"), so it is checked for
//    resolvability, not generated.
problems.push(...barrelTableProblems());

function publishedSpecifiers() {
  const out = new Set();
  const packagesDir = join(ROOT, "packages");
  for (const dir of readdirSync(packagesDir)) {
    const text = readOrNull(join(packagesDir, dir, "package.json"));
    if (text === null) continue;
    const { name, exports } = JSON.parse(text);
    if (!name) continue;
    for (const key of Object.keys(exports ?? { ".": true })) out.add(specifierOf(key, name));
  }
  return out;
}

function barrelTableProblems() {
  const indexPath = join(SDK_DIR, "src/index.ts");
  const source = readFileSync(indexPath, "utf8");
  const start = source.indexOf("## Everything else is on a subpath");
  if (start === -1) return [];
  const table = source.slice(start, source.indexOf("@module", start));
  const known = publishedSpecifiers();
  const found = [];
  let pkg = "@alexkroman1/aai";
  for (const line of table.split("\n").filter((one) => /^\s*\*\s*\|/.test(one))) {
    const cell = line.split("|")[1] ?? "";
    for (const [, spec = ""] of cell.matchAll(/`([^`]+)`/g)) {
      if (spec.startsWith("@alexkroman1/")) {
        const [scope, name] = spec.split("/");
        pkg = `${scope}/${name}`;
        found.push(spec);
      } else if (spec.startsWith("/")) {
        found.push(`${pkg}${spec}`);
      }
    }
  }
  if (found.length === 0) {
    return [
      `${rel(indexPath)}'s subpath table parsed to nothing — the parser in ` +
        "scripts/sync-agent-guide.mjs no longer matches its shape.",
    ];
  }
  return found
    .filter((spec) => !known.has(spec))
    .map(
      (spec) =>
        `${rel(indexPath)}'s subpath table names \`${spec}\`, which no package exports — an ` +
        "author who copies it gets ERR_PACKAGE_PATH_NOT_EXPORTED.",
    );
}

if (CHECK) {
  for (const { path, why } of writes) problems.push(`${rel(path)} is out of date: ${why}.`);
  for (const path of removals) {
    problems.push(`${rel(path)} has no source in ${rel(join(SOURCE_DIR, TOPIC_DIR))} — delete it.`);
  }
  if (problems.length > 0) {
    console.error(`\nsync-agent-guide: ${problems.length} problem(s).\n`);
    for (const problem of problems) console.error(`  - ${problem}\n`);
    console.error(
      "The guide ships inside the @alexkroman1/aai tarball so a project reads guidance\n" +
        "matching the SDK it resolved. Run `pnpm sync:agent-guide` and commit the result;\n" +
        "fix anything it cannot write by hand.\n",
    );
    process.exit(1);
  }
  console.log(
    `sync-agent-guide: ${guideFiles().length} guide file(s) and the subpath lists are current. ✓`,
  );
  process.exit(0);
}

if (problems.length > 0) {
  console.error(`\nsync-agent-guide: ${problems.length} problem(s) to fix by hand.\n`);
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}
for (const { path, expected } of writes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, expected);
  console.log(`sync-agent-guide: wrote ${rel(path)}`);
}
for (const path of removals) {
  rmSync(path);
  console.log(`sync-agent-guide: removed ${rel(path)}`);
}
if (writes.length === 0 && removals.length === 0) {
  console.log("sync-agent-guide: already current.");
}
