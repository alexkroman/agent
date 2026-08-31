#!/usr/bin/env node

/**
 * Materialize the agent-authoring guide into the `@alexkroman1/aai` tarball.
 *
 * ## The drift this removes
 *
 * `packages/aai-templates/scaffold/CLAUDE.md` is already the one source of
 * truth for how to write an aai agent — `studio-prompt.ts` embeds it in the
 * studio's system prompt, and `aai init` copies it into every scaffolded
 * project. What it is NOT is version-matched to the SDK a project ends up
 * resolving.
 *
 * The copy in a project is frozen at the moment `aai init` ran. The CLI, `aai`
 * and `aai-ui` release together (the fixed group in `.changeset/config.json`),
 * so that copy is correct on day one — and then the project runs
 * `pnpm update @alexkroman1/aai`, the SDK moves, and the guide does not. An
 * agent working in that project reads guidance for a version that is no longer
 * installed, with nothing saying so. That is the same silent-staleness shape as
 * the guest toolchain lockfile (`check:guest-toolchain`) and the studio's
 * prebuilt client: a committed copy that looks current and is not.
 *
 * So the guide also ships INSIDE the `aai` package, where its version is the
 * SDK's version by construction — `node_modules/@alexkroman1/aai/AGENT_GUIDE.md`
 * cannot be older or newer than the `@alexkroman1/aai` beside it.
 * `packages/aai/skills/aai/SKILL.md` is the thin skill that points there and
 * deliberately carries no guidance of its own, because a skill installed in a
 * user's home directory has no version at all.
 *
 * ## Why a repo-level script and not a package dependency
 *
 * `aai` must import no sibling package — AGENTS.md's dependency flow, enforced
 * by `konsistent.json`. A build step in `aai` reading from `aai-templates`
 * would invert that. This script lives at the repo root and reads both trees,
 * so neither package declares anything about the other; the copy is committed,
 * and `--check` is what keeps it honest.
 *
 *   node scripts/sync-agent-guide.mjs           # write the copy
 *   node scripts/sync-agent-guide.mjs --check    # fail if it is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const SOURCE = join(ROOT, "packages/aai-templates/scaffold/CLAUDE.md");
const DESTINATION = join(ROOT, "packages/aai/AGENT_GUIDE.md");
const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const CHECK = FLAGS.check === true;

/**
 * A banner on the copy, so nobody edits the wrong file.
 *
 * It is part of the compared content: without it, an edit that removed the
 * banner would leave a copy that looks authored, and the next person to change
 * the guide would have two plausible files to pick from.
 */
const BANNER = [
  "<!--",
  "  GENERATED FILE — do not edit.",
  "",
  "  Source: packages/aai-templates/scaffold/CLAUDE.md",
  "  Regenerate: node scripts/sync-agent-guide.mjs",
  "",
  "  This copy ships inside the @alexkroman1/aai tarball so an agent working in",
  "  a user's project can read guidance that MATCHES the installed SDK, rather",
  "  than the copy `aai init` froze into the project at scaffold time. See",
  "  packages/aai/skills/aai/SKILL.md.",
  "-->",
  "",
].join("\n");

const source = readFileSync(SOURCE, "utf8");
const expected = `${BANNER}${source}`;

let actual;
try {
  actual = readFileSync(DESTINATION, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  actual = null;
}

if (!CHECK) {
  if (actual === expected) {
    console.log("sync-agent-guide: packages/aai/AGENT_GUIDE.md already current.");
    process.exit(0);
  }
  writeFileSync(DESTINATION, expected);
  console.log(
    `sync-agent-guide: wrote packages/aai/AGENT_GUIDE.md (${expected.length.toLocaleString("en-US")} chars).`,
  );
  process.exit(0);
}

if (actual === expected) {
  console.log("sync-agent-guide: packages/aai/AGENT_GUIDE.md matches the scaffold guide. ✓");
  process.exit(0);
}

console.error(
  `\nsync-agent-guide: packages/aai/AGENT_GUIDE.md is ${actual === null ? "missing" : "stale"}.\n\n` +
    "It is a generated copy of packages/aai-templates/scaffold/CLAUDE.md that\n" +
    "ships inside the @alexkroman1/aai tarball, so a project that has since\n" +
    "updated its SDK can read guidance matching the version it actually\n" +
    "resolved. A stale copy is the failure it exists to prevent, arriving from\n" +
    "the other direction.\n\n" +
    "Run `node scripts/sync-agent-guide.mjs` and commit the result.\n",
);
process.exit(1);
