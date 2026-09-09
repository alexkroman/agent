#!/usr/bin/env node

/**
 * Materialize what the studio SENDS a coding-agent session, where its EVAL can
 * read it: the system prompt per project kind, and the starter catalog.
 *
 * ## The measurement this makes possible
 *
 * `packages/aai-guest/src/studio-agent.eval.test.ts` drives the real coding
 * agent — the real tools, the real executor, a real workspace — on a system
 * prompt that is NOT the shipped one. It runs `STUDIO_EVAL_PROMPT`, a four-line
 * harness constant, because the shipped prompt is `studioSystemPrompt(kind)` in
 * `aai-studio-server` and `guest-package-boundary` denies the guest that import.
 *
 * That limit is documented honestly in `CODING-AGENT-TESTS-CLAUDE.md` ("no
 * result from this file may be reported as covering it") and it is the wrong
 * place to stop, because the repo's own template evals say why:
 *
 *     an eval run against the framework default prompt measures an agent
 *     nobody deployed
 *     — templates/text-adventure-agent/agent.eval.test.ts
 *
 * A studio starter outcome is very largely a measurement OF that prompt. Grading
 * one against the harness constant measures a string nobody ships.
 *
 * ## Why a committed artifact and not an import
 *
 * Two reasons, and the second is the hard one.
 *
 * **The prompt is already data, not code.** The guest never imports it in
 * production either: `studio-session-ensure.ts` puts `studioSystemPrompt(kind)`
 * in the session-init payload and `studio-session.ts` appends
 * `toolchainPromptSection()` to whatever arrives over the wire. The guest is the
 * thing that RUNS that string. Handing the same string to the eval is the
 * runtime arrangement, not a new privilege.
 *
 * **An import would close a workspace cycle.** `aai-server` depends on
 * `aai-guest` (it resolves the built harness artifact), so `aai-guest` →
 * `aai-studio-server` → `aai-server` → `aai-guest`. `turbo.json`'s `build` is
 * `dependsOn: ["^build"]`, which follows dev dependencies too, so that is a hard
 * task-graph error rather than a lint opinion — the boundary rule is downstream
 * of a real constraint here, not the constraint itself.
 *
 * So this is `sync-agent-guide.mjs`'s shape: a REPO-LEVEL script that reads both
 * trees, writes a committed copy, and offers `--check` so the copy cannot go
 * stale silently. Neither package declares anything about the other. It is also
 * the shape templates already use — `system-prompt.md` reaches a template eval
 * as a build artifact through `virtual:aai/agent`, never as an import of
 * whatever composed it.
 *
 * The starter catalog rides along for the same reason and by the same rule — see
 * {@link STARTERS_FILE}.
 *
 *   node scripts/sync-studio-prompt.mjs           # write the copies
 *   node scripts/sync-studio-prompt.mjs --check   # fail if one is stale
 *
 * ## Why a child process
 *
 * The prompt is composed by TypeScript that resolves workspace packages through
 * the `@dev/source` export condition, so it is imported by a node child spawned
 * with `--conditions=@dev/source` — the same thing `build-guest-image.mjs` does
 * to reach `modal-harness-image.ts` from a `.mjs` script.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const DESTINATION_DIR = join(ROOT, "packages/aai-guest/studio-prompts");
const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const CHECK = FLAGS.check === true;

/**
 * A banner on each copy, so nobody edits the wrong file.
 *
 * Part of the compared content, for `sync-agent-guide.mjs`'s reason: without it
 * an edit that removed the banner leaves a copy that looks authored, and the
 * next person to change the prompt has two plausible files to choose from.
 */
const banner = (kind) =>
  [
    "<!--",
    "  GENERATED FILE — do not edit.",
    "",
    `  Source: packages/aai-studio-server/src/prompts/ (studioSystemPrompt(${JSON.stringify(kind)}))`,
    "  Regenerate: node scripts/sync-studio-prompt.mjs",
    "",
    "  This is the system prompt the studio really sends a coding-agent session,",
    "  committed here so packages/aai-guest's eval can run the SHIPPED prompt",
    "  without importing aai-studio-server — an import would close the cycle",
    "  aai-guest -> aai-studio-server -> aai-server -> aai-guest.",
    "",
    "  It is the host half only. The guest appends toolchainPromptSection() at",
    "  session install, exactly as it does in production.",
    "-->",
    "",
  ].join("\n");

/**
 * The starter catalog, as a committed fixture.
 *
 * `STARTERS` (aai-studio-client) is the set of prompts the studio's new-project
 * screen really offers, and the guest eval grades OUTCOMES against them — so it
 * needs the shipped set, not a copy someone typed. Same import problem and the
 * same answer as the system prompt above: `guest-package-boundary` denies
 * `aai-studio-client`, so the catalog is written here as data and
 * `check:studio-prompt` keeps it current.
 *
 * JSON carries no comment, so the banner is a `_generated` KEY — part of the
 * compared content for the same reason the markdown banner is: a copy that
 * looks authored is one somebody edits.
 */
const STARTERS_FILE = "starters.json";

/**
 * Compose every kind's prompt, in one child process.
 *
 * The scaffold guide is read from disk by `loadScaffoldGuide()` — the same call
 * the studio makes — rather than passed in, so a run here fails the same way a
 * deployment would if that file went missing, instead of quietly recording the
 * compact fallback as though it were the shipped text.
 */
function composePrompts() {
  const program = [
    'import { PROJECT_KINDS } from "../packages/aai-studio-server/src/studio-project-kind.ts";',
    'import { composeStudioPrompt, loadScaffoldGuide } from "../packages/aai-studio-server/src/prompts/studio-prompt.ts";',
    'import { STARTERS } from "../packages/aai-studio-client/src/starters.ts";',
    "const guide = loadScaffoldGuide();",
    'if (guide === null) throw new Error("scaffold CLAUDE.md not found — the fallback guide is not the shipped prompt");',
    "const prompts = {};",
    "for (const kind of PROJECT_KINDS) prompts[kind] = composeStudioPrompt(guide, kind);",
    "process.stdout.write(JSON.stringify({ prompts, starters: STARTERS }));",
  ].join("\n");
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["--conditions=@dev/source", "--input-type=module", "-e", program],
    { cwd: join(ROOT, "scripts"), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (status !== 0 || !stdout) {
    throw new Error(
      `sync-studio-prompt: could not compose the studio prompt: ${stderr.trim() || `exit ${status}`}`,
    );
  }
  return JSON.parse(stdout);
}

const { prompts, starters } = composePrompts();
const files = Object.entries(prompts).map(([kind, prompt]) => ({
  kind,
  path: join(DESTINATION_DIR, `${kind}.md`),
  rel: `packages/aai-guest/studio-prompts/${kind}.md`,
  expected: `${banner(kind)}${prompt}`,
}));
files.push({
  kind: "starters",
  path: join(DESTINATION_DIR, STARTERS_FILE),
  rel: `packages/aai-guest/studio-prompts/${STARTERS_FILE}`,
  expected: `${JSON.stringify(
    {
      _generated:
        "GENERATED FILE — do not edit. Source: packages/aai-studio-client/src/starters.ts " +
        "(STARTERS). Regenerate: node scripts/sync-studio-prompt.mjs",
      ...starters,
    },
    null,
    2,
  )}\n`,
});

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
};

const stale = files.filter((file) => read(file.path) !== file.expected);

if (!CHECK) {
  if (stale.length === 0) {
    console.log("sync-studio-prompt: studio prompt copies already current.");
    process.exit(0);
  }
  mkdirSync(DESTINATION_DIR, { recursive: true });
  for (const file of stale) writeFileSync(file.path, file.expected);
  console.log(
    `sync-studio-prompt: wrote ${stale
      .map((f) => `${f.rel} (${f.expected.length.toLocaleString("en-US")} chars)`)
      .join(", ")}.`,
  );
  process.exit(0);
}

if (stale.length === 0) {
  console.log("sync-studio-prompt: studio prompt copies match aai-studio-server. ✓");
  process.exit(0);
}

console.error(
  `\nsync-studio-prompt: ${stale.map((f) => f.rel).join(", ")} ${stale.length === 1 ? "is" : "are"} stale or missing.\n\n` +
    "These are generated copies of the system prompt the studio sends a coding-\n" +
    "agent session. packages/aai-guest's eval runs the shipped prompt from them,\n" +
    "so a stale copy means that eval is grading a prompt nobody deploys — which\n" +
    "is the exact failure the copies exist to prevent, arriving from the other\n" +
    "direction and reporting green while it happens.\n\n" +
    "Run `node scripts/sync-studio-prompt.mjs` and commit the result.\n",
);
process.exit(1);
