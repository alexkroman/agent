#!/usr/bin/env node

/**
 * Committed markdown API reference, for a reader with no browser.
 *
 * ## The gap this closes
 *
 * `pnpm docs:api` renders TypeDoc to HTML and `docs.yml` publishes it to
 * GitHub Pages. That is the right artifact for a human and useless to a coding
 * agent working in this repo: reaching it means a network fetch of a rendered
 * site, and what comes back is navigation chrome around the content.
 *
 * The two artifacts that ARE in the tree answer a different question.
 * The per-entry-point reports under each package's `etc/` and the `API.md`
 * they concatenate are rolled-up
 * public `.d.ts` — signatures, and deliberately nothing else, because their job
 * is to make a signature change a reviewable diff. Every doc comment in this
 * repo is stripped out of them. Those comments are substantial (`tools.md`
 * opens with 40 lines on why the network builtins are reachable from tool code
 * at all) and they are exactly what someone has to read to use the API
 * correctly.
 *
 * So this is the third artifact: TypeDoc's own output, in markdown, committed
 * under `docs/api/`, one file per published entry point. `cat
 * docs/api/@alexkroman1/aai/tts.md` is the whole interaction.
 *
 * ## Why a script rather than a `typedoc` invocation
 *
 * TypeDoc has no check mode, and a generated file that is committed needs one
 * or it goes stale — silently, which is the failure this repo keeps paying for.
 * The two modes therefore share ONE generation path: both render into a
 * throwaway directory, and only then does the mode decide whether to sync the
 * result into `docs/api/` or diff against it. Neither can be looking at
 * something the other would not produce.
 *
 * ## The floor
 *
 * A diff-based gate passes when an empty tree agrees with an empty tree, and
 * its whole success output is a count — the same shape as the five gates
 * AGENTS.md records having caught printing a checkmark over nothing. So the
 * render is floored on BOTH file count and total bytes before anything is
 * compared. A TypeDoc upgrade that changed the output layout, an `extends`
 * that stopped resolving, or an entry-point list that emptied would all
 * otherwise report success.
 *
 * ## Usage
 *
 *   node scripts/docs-markdown.mjs           # write/refresh docs/api/
 *   node scripts/docs-markdown.mjs --check   # fail if it is stale
 *
 * `--check` is what runs in `pnpm check` and CI. It needs the emitted
 * `dist/*.d.ts` of `aai` and `aai-ui`, so it runs after the build, beside
 * `check:api-report`.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { compareNames, repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const CHECK = process.argv.includes("--check");

/** Where the committed reference lives, repo-relative. */
const OUT_DIR = "docs/api";

/**
 * The script that renders it, in the workspace that owns the TypeDoc install.
 *
 * Invoked through pnpm rather than as `pnpm exec typedoc` from here, because
 * `scripts/` belongs to the ROOT workspace and typedoc is a dependency of
 * `docs/`. Reaching across would work and knip reports it as an unlisted
 * binary — correctly: the dependency that makes this script runnable would be
 * declared nowhere near it, and removing `docs/` would break it silently.
 */
const RENDER_SCRIPT = ["--filter", "aai-docs", "run", "docs:md"];

/**
 * Floors, from a measured actual — 18 files, ~728 KB at the time of writing.
 *
 * Set well under, because these move whenever a subpath is added or a doc
 * comment is rewritten and a floor that tracks the actual is a floor that has
 * to be edited by every unrelated change. They are here to catch a render that
 * produced NOTHING, not to pin a size.
 */
const MIN_FILES = 12;
const MIN_BYTES = 300_000;

/** Every `.md` under `dir`, repo-relative to it, sorted by code unit. */
function markdownFiles(dir) {
  /** @type {string[]} */
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) found.push(relative(dir, path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort(compareNames);
}

/**
 * Render the reference into a fresh temp directory and return its path.
 *
 * `--out` is passed on the command line rather than read from the config so
 * that the config's `out` can stay the real destination — a reader opening
 * `typedoc.markdown.json` should see where the artifact goes, not a temp path.
 */
function render() {
  const dir = mkdtempSync(join(tmpdir(), "aai-docs-md-"));
  try {
    execFileSync("pnpm", [...RENDER_SCRIPT, "--out", dir], {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      "typedoc failed to render the markdown reference. It reads the emitted " +
        "dist/*.d.ts of aai and aai-ui, so run `pnpm build` first; a resolved " +
        "link warning is an ERROR here, because the config inherits " +
        "treatWarningsAsErrors from docs/typedoc.json.",
      { cause: err },
    );
  }
  return dir;
}

/** Fail loudly when a render produced less than a render can plausibly produce. */
function floor(dir, files) {
  const bytes = files.reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
  if (files.length < MIN_FILES || bytes < MIN_BYTES) {
    console.error(
      `docs-markdown: rendered ${files.length} file(s) / ${bytes} bytes, under the ` +
        `floor of ${MIN_FILES} / ${MIN_BYTES}. That is not a docs change — the ` +
        "render itself stopped working (an entry-point list that resolved to " +
        "nothing, an `extends` that stopped resolving, a plugin whose output " +
        "layout moved). Fix the render; do not lower the floor to match it.",
    );
    process.exit(1);
  }
  return bytes;
}

const fresh = render();
try {
  const freshFiles = markdownFiles(fresh);
  const bytes = floor(fresh, freshFiles);
  const committedDir = join(ROOT, OUT_DIR);

  if (!CHECK) {
    // Replace wholesale rather than merge: a subpath that stops being exported
    // must take its file with it, and a copy-over-the-top would leave it behind
    // to be read as current forever.
    rmSync(committedDir, { recursive: true, force: true });
    cpSync(fresh, committedDir, { recursive: true });
    console.log(
      `docs-markdown: wrote ${freshFiles.length} file(s) (${bytes} bytes) to ${OUT_DIR}/`,
    );
    process.exit(0);
  }

  const committedFiles = markdownFiles(committedDir);
  const added = freshFiles.filter((f) => !committedFiles.includes(f));
  const removed = committedFiles.filter((f) => !freshFiles.includes(f));
  const changed = freshFiles
    .filter((f) => committedFiles.includes(f))
    .filter(
      (f) => readFileSync(join(fresh, f), "utf8") !== readFileSync(join(committedDir, f), "utf8"),
    );

  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    console.error(`\n${OUT_DIR}/ is stale. Run \`pnpm docs:md\` and commit the result.\n`);
    for (const f of added) console.error(`  + ${OUT_DIR}/${f}`);
    for (const f of removed) console.error(`  - ${OUT_DIR}/${f}`);
    for (const f of changed) console.error(`  M ${OUT_DIR}/${f}`);
    console.error("");
    process.exit(1);
  }

  console.log(`docs-markdown: ${OUT_DIR}/ is current — ${freshFiles.length} file(s) ✓`);
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
