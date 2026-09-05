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
 * ## The two things the floor cannot see
 *
 * **A subpath that is published and never documented.** `docs/CLAUDE.md` states
 * the rule — "a new subpath export needs an entry in that package's
 * `typedoc.json` too" — and until this check it was enforced by nothing. Three
 * `aai` subpaths and one `aai-ui` subpath had drifted out, one of them
 * (`aai-ui/client-dir`) a contracted capability with its own API report. A
 * missing FILE is invisible to a floor set well under the actual, and invisible
 * to the diff, because the diff only compares what the render produced.
 * `UNDOCUMENTED_SUBPATHS` is a DENY-list, for the reason AGENTS.md gives for
 * `NON_AUTHORING_SUBPATHS`: a new subpath then defaults INTO being documented
 * and fails here until somebody decides otherwise in writing.
 *
 * **A link whose anchor does not exist.** `treatWarningsAsErrors` guarantees
 * that a `{@link}` resolved in TypeDoc's MODEL; it says nothing about whether
 * the emitted markdown anchor exists, because the plugin's anchor registry and
 * the heading a reader's markdown renderer slugs are computed independently.
 * Nine dead jumps sat in the middle of the `Dialog` API for exactly that
 * reason. `assertLinksResolve` resolves every internal link against the heading
 * slugs of the file it points at.
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
import { cpSync, globSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScriptArgs } from "./_args.mjs";
import { compareNames, repoRoot } from "./_fs.mjs";
import { resolveLinks } from "./docs-markdown-links.mjs";

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const CHECK = FLAGS.check === true;

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
 * Floors, from a measured actual — 27 files, ~1.08 MB at the time of writing.
 *
 * Set well under, because these move whenever a subpath is added or a doc
 * comment is rewritten and a floor that tracks the actual is a floor that has
 * to be edited by every unrelated change. They are here to catch a render that
 * produced NOTHING, not to pin a size.
 */
const MIN_FILES = 12;
const MIN_BYTES = 300_000;

/**
 * Published subpaths that are deliberately NOT in the reference, each with the
 * reason it is not.
 *
 * Keyed by the package directory under `packages/`. Every other `exports` key
 * with a `types` target must appear in that package's `typedoc.json`
 * `entryPoints` — see `assertSubpathCoverage`.
 *
 * A deny-list rather than an allow-list, and the direction is the whole point:
 * an allow-list of documented subpaths is satisfied by not adding to it, which
 * is exactly how `./workspace-files`, `./slugify` and `aai-ui/./client-dir`
 * ended up published and undocumented with no gate noticing. A deny-list makes
 * the DEFAULT "documented" and turns the omission into a failure that names
 * itself. Same reasoning as `NON_AUTHORING_SUBPATHS` in
 * `scripts/_api-contracts.mjs`.
 *
 * "Non-authoring" is NOT the test here, and must not become one: `/protocol`,
 * `/runtime` and `/manifest` are all on that list and all get a full page —
 * `runtime.md` is the second-largest file in the tree. The test is whether a
 * reader could ever need prose about the subpath, which is a different
 * question from whether an `agent.ts` imports it.
 */
const UNDOCUMENTED_SUBPATHS = {
  aai: {
    "./testing/vite":
      "a Vite plugin serving `virtual:aai/agent`. Its consumer is a `vitest.config.ts`, not an " +
      "agent.ts or a spec body, and its one exported function is documented at its own source — " +
      "a reference page here would sit under the authoring API describing build wiring.",
    "./internal":
      "The escape hatch, not an API. Its 49 exports are `@internal` by " +
      "intent — the subpath exists so they are reachable without sitting in " +
      "an agent author's autocomplete, and rendering them would undo that. " +
      "Named in packages/aai/README.md under 'Other subpaths'.",
    "./slugify":
      "One function, `slugify`, over a string. Consumed by the CLI and the " +
      "platform to derive an agent id from a name; there is no decision for " +
      "a reader to make and nothing a page would say that the signature does " +
      "not.",
    "./workspace-files":
      "The studio's workspace file-tree helpers. Published because " +
      "aai-studio-server and the CLI both need them across the package " +
      "boundary, not because an agent author calls them — the surface is " +
      "internal plumbing that happens to cross a package line.",
    "./host-internal":
      "The seam @alexkroman1/aai-runtime imports across the package " +
      "boundary: tuning constants, the resolve*Settings functions and a few " +
      "helpers. Same argument as ./internal — it exists so the runtime can " +
      "reach them without them sitting in an agent author's autocomplete.",
  },
  "aai-ui": {
    "./internal":
      "The escape hatch, not an API. Its eight exports are `@internal` by " +
      "intent — the two providers `client()` mounts, the default shell's URL " +
      "chips, the tool-config context and the session's own client-config " +
      "lookup — and the subpath exists so they are reachable without sitting " +
      "in a CLIENT author's autocomplete beside `client()` and `<Form>`. " +
      "Rendering them would undo that. Named in packages/aai-ui/README.md " +
      "under 'Other subpaths'.",
  },
  "aai-runtime": {
    "./tracing":
      "OTLP span export, configured through the ENVIRONMENT rather than in " +
      "code: `OTEL_EXPORTER_OTLP_ENDPOINT` is the whole switch, and the three " +
      "front doors (`aai start`, `aai dev`, the guest harness) call " +
      "`startTracingDetached` on the operator's behalf. So a rendered " +
      "signature page answers a question almost nobody has — the seven " +
      "exports exist for a self-hoster embedding `createRuntimeServer` in a " +
      "process of their own, who needs the handle rather than a reference " +
      "page. What that reader wants is the prose: the env vars, the " +
      "optional-peer install line and the no-conversation-content guarantee, " +
      "which are in the scaffold guide under 'Tracing (OpenTelemetry)' — the " +
      "one that ships inside the SDK tarball as `AGENT_GUIDE.md`, and which " +
      "`check:authoring-guide` holds to naming this " +
      "capability. Same reason as the '.' entry below, one subpath in: this " +
      "is an EMBEDDER surface. Revisit if embedders ask for a rendered page.",
    ".":
      "The host runtime, ~220 exports aimed at somebody EMBEDDING an agent " +
      "rather than writing one. Rendering it is what this split undid: it " +
      "was two thirds of a combined reference whose readers are agent " +
      "authors. Its README and packages/aai-runtime/CLAUDE.md carry the " +
      "orientation, and the signatures are in etc/*.api.md like every other " +
      "published package. Revisit if embedders ask for a rendered page — " +
      "then it gets its own, not a share of the SDK's. Note this reason is " +
      "about the EMBEDDER surface and reaches no further: /eval, " +
      "/eval/vitest and /testing are read by whoever writes the agent.ts, " +
      "so they are documented, and the package is in docs/typedoc.json for " +
      "them alone.",
    "./internal":
      "Cross-package infrastructure, in two halves: the SDK names " +
      "re-exported from @alexkroman1/aai/host-internal, undocumented for the " +
      "same reason on the SDK side, and this package's OWN host plumbing — " +
      "the transports, the session core, the workflow engine wiring, the " +
      "state and upload stores — that aai-server, aai-cli and aai-guest " +
      "import across the package boundary. Neither half is semver-covered " +
      "and neither is anything an agent author or an embedder writes " +
      "against. Its whole job is to keep those names OFF the root barrel a " +
      "reader does autocomplete over.",
  },
};

/**
 * Minimum number of published subpaths the coverage check must have inspected.
 *
 * Its success output is a count, so a manifest read that stopped finding
 * `exports`, or a package list that emptied, would report "every published
 * subpath is documented ✓" over nothing. Measured actual: 27 (19 on `aai`,
 * 3 on `aai-ui`, 5 on `aai-runtime`).
 */
const MIN_SUBPATHS = 15;

/**
 * A string literal, a line comment, a block comment, or a trailing comma — in
 * that order, which is the whole trick.
 *
 * The string branch is tried first at every position, so `"https://…"` and a
 * `","` inside a value are consumed AS strings and the comment and comma
 * branches never see them. A naive `//`-strip is wrong on the first URL it
 * meets, which is what a `$schema` line is.
 */
const JSONC_TOKEN = /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g;

/**
 * JSON with comments, which is what a `typedoc.json` in this repo is.
 *
 * `readJson` from `_fs.mjs` is `JSON.parse`, and `packages/aai/typedoc.json`
 * carries block comments explaining its `intentionallyNotExported` list.
 * Trailing commas go too, since a config a human hand-edits will eventually
 * have one and `JSON.parse` rejects it with a message that names neither the
 * file nor the line.
 */
function parseJsonc(path) {
  const text = readFileSync(path, "utf8").replace(JSONC_TOKEN, (_match, string) => string ?? "");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err.message}`, { cause: err });
  }
}

/** Every `exports` key of `manifest` whose target declares `types`. */
function typedSubpaths(manifest) {
  return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) =>
    // A string target (`"./styles.css"`) ships an asset, not types. `?.` covers
    // the `typeof null === "object"` case without a second comparison.
    typeof target === "object" && target?.types ? [{ subpath, types: target.types }] : [],
  );
}

/** One package's disagreements between what it publishes and what it documents. */
function subpathProblems(dir, denied) {
  const manifest = parseJsonc(join(ROOT, dir, "package.json"));
  const entryPoints = new Set(parseJsonc(join(ROOT, dir, "typedoc.json")).entryPoints ?? []);
  const published = typedSubpaths(manifest);
  /** @type {string[]} */
  const problems = [];

  for (const { subpath, types } of published) {
    const expected = types.replace(/^\.\//, "");
    const documented = entryPoints.has(expected);
    const excused = subpath in denied;
    if (documented && excused) {
      problems.push(
        `${dir} documents ${subpath} AND lists it in UNDOCUMENTED_SUBPATHS. Remove the ` +
          "deny-list entry; a reason nobody acts on reads as a decision that was made.",
      );
    } else if (!(documented || excused)) {
      problems.push(
        `${dir} publishes ${subpath} (${types}) and ${dir}/typedoc.json does not document ` +
          `it. Add "${expected}" to its entryPoints, or add ${subpath} to ` +
          "UNDOCUMENTED_SUBPATHS in scripts/docs-markdown.mjs with the reason it stays out.",
      );
    }
  }

  const names = new Set(published.map((entry) => entry.subpath));
  for (const subpath of Object.keys(denied)) {
    if (names.has(subpath)) continue;
    problems.push(
      `${dir} no longer publishes ${subpath}, but UNDOCUMENTED_SUBPATHS still excuses it. ` +
        "Delete the entry.",
    );
  }
  return { problems, inspected: published.length };
}

/**
 * Every published subpath with a `types` target is either a typedoc entry point
 * or carries a written reason for not being one.
 *
 * The package list is DERIVED from `docs/typedoc.json`'s own `entryPoints`, not
 * repeated here, so opting a third package into the reference does not also
 * mean remembering to opt it into this check.
 */
function assertSubpathCoverage() {
  const docsConfig = parseJsonc(join(ROOT, "docs/typedoc.json"));
  const packageDirs = (docsConfig.entryPoints ?? []).map((entry) => entry.replace(/^\.\.\//, ""));
  /** @type {string[]} */
  const problems = [];
  let inspected = 0;

  for (const dir of packageDirs) {
    const denied = UNDOCUMENTED_SUBPATHS[dir.split("/").pop()];
    if (!denied) {
      problems.push(
        `${dir} is documented by docs/typedoc.json but has no UNDOCUMENTED_SUBPATHS entry. ` +
          "Add one — `{}` if every subpath of it is documented — so the deny-list stays exhaustive.",
      );
      continue;
    }
    const result = subpathProblems(dir, denied);
    problems.push(...result.problems);
    inspected += result.inspected;
  }

  if (inspected < MIN_SUBPATHS) {
    problems.push(
      `inspected only ${inspected} published subpath(s), under the floor of ${MIN_SUBPATHS}. ` +
        "The manifests stopped being read, or the package list emptied — either way this " +
        "check was about to pass over nothing.",
    );
  }

  if (problems.length > 0) {
    console.error("\ndocs-markdown: published subpaths and documented entry points disagree.\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    process.exit(1);
  }
  return inspected;
}

/**
 * Every `.md` under `dir`, relative to it, sorted by code unit.
 *
 * `globSync` here and `readdirSync({ recursive: true })` in the two measurement
 * walkers, and the split is deliberate rather than taste. Glob does not match a
 * path segment beginning with a dot, which makes it wrong for "every file in
 * this tree" (a dropped dotfile is a silent undercount) and right for "every
 * file matching this pattern" — a `.md` whose name starts with a dot is not a
 * documentation page, and `docs/api/**` is generated by TypeDoc, which writes
 * none. `cwd` also means the paths come back relative already, which is what
 * the caller wanted the `relative()` call for.
 *
 * `globSync` answers `[]` for a directory that does not exist, so the
 * `existsSync` guard this replaced is no longer needed.
 */
function markdownFiles(dir) {
  return globSync("**/*.md", { cwd: dir }).sort(compareNames);
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

assertSubpathCoverage();

const fresh = render();
try {
  const freshFiles = markdownFiles(fresh);
  const bytes = floor(fresh, freshFiles);
  const { checked, repairs } = resolveLinks(fresh, freshFiles);
  for (const repair of repairs) console.log(`docs-markdown: repaired anchor — ${repair}`);
  console.log(`docs-markdown: ${checked} internal link(s) resolve ✓`);
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
