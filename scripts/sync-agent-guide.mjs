#!/usr/bin/env node

/**
 * Materialize the agent-authoring guide into the `@alexkroman1/aai` tarball.
 *
 * ## The drift this removes
 *
 * `packages/aai-templates/scaffold/CLAUDE.md` is already the one source of
 * truth for how to write an aai agent — `studio-prompt.ts` embeds it in the
 * studio's system prompt. What it is NOT is version-matched to the SDK a
 * project ends up resolving.
 *
 * `aai init` used to copy it into every scaffolded project, and that copy was
 * frozen at the moment `aai init` ran. The CLI, `aai` and `aai-ui` release
 * together (the fixed group in `.changeset/config.json`), so it was correct on
 * day one — and then the project ran `pnpm update @alexkroman1/aai`, the SDK
 * moved, and the guide did not. An agent working in that project read guidance
 * for a version that was no longer installed, with nothing saying so. That is
 * the same silent-staleness shape as the guest toolchain lockfile
 * (`check:guest-toolchain`) and the studio's prebuilt client: a committed copy
 * that looks current and is not.
 *
 * So the guide ships INSIDE the `aai` package, where its version is the SDK's
 * version by construction — `node_modules/@alexkroman1/aai/AGENT_GUIDE.md`
 * cannot be older or newer than the `@alexkroman1/aai` beside it. This copy is
 * now the ONLY one a project has: `layerScaffold` writes a short pointer at it
 * as the project's `CLAUDE.md` rather than copying 120KB whose staleness this
 * whole script exists to argue about (see `PROJECT_GUIDE_POINTER` in
 * `packages/aai-cli/src/_templates.ts`).
 * `packages/aai/skills/aai/SKILL.md` is the thin skill that points at the same
 * file and deliberately carries no guidance of its own, because a skill
 * installed in a user's home directory has no version at all.
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
  "  a user's project reads guidance that MATCHES the installed SDK. It is the",
  "  only copy such a project has: `aai init` writes a short pointer at this",
  "  path as the project's CLAUDE.md rather than a snapshot that goes stale on",
  "  the next `pnpm update`. See packages/aai/skills/aai/SKILL.md.",
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
