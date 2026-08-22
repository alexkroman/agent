// Copyright 2026 the AAI authors. MIT license.
/**
 * Compile every TypeScript code example in the docs — the ```ts / ```tsx
 * fences in published-package doc comments and in the user-facing markdown
 * (scaffold CLAUDE.md, READMEs) — under the SCAFFOLD's tsconfig, the same
 * compiler `check-template-types` holds templates to.
 *
 * Nothing else checks these. TypeDoc renders fences verbatim, the bundlers
 * never see them, and the two real bugs that motivated this gate were both
 * example-only: a shipped `@example` calling `agent()` with a `voice` field
 * the type does not have, and a README example passing `params:` where
 * `tool()` takes `parameters:` — each compiled nowhere and so failed nowhere,
 * while being exactly what a reader (human or coding agent) copies first.
 *
 * Every example must be SELF-CONTAINED: it imports what it uses and declares
 * what it references. A fence that is deliberately a fragment (a type-shape
 * listing, an API sketch) opts out with `no-check` in the fence info string:
 *
 *   ```ts no-check
 *
 * Renderers take the language from the first token, so the marker changes
 * nothing visually. Blocks in non-`ts`/`tsx` languages are never checked.
 *
 *   pnpm check:doc-examples
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT as repo, runScaffoldTsc } from "./_scaffold-tsc.mjs";

// Inside aai-templates so bare imports (`@alexkroman1/aai`, `zod`, react)
// resolve by the normal node_modules walk-up, exactly as templates do.
const scratch = path.join(repo, `packages/aai-templates/.doc-examples-scratch-${process.pid}`);

/**
 * Doc-comment sources: published packages' source trees — ALL FOUR of them.
 *
 * `aai-runtime` was absent from the day the runtime split created it, so the
 * package a self-hoster reads first had its seven `@example` blocks compiled
 * by nothing. A new published package owes an entry here and one in
 * `MARKDOWN_FILES`, or its doc comments are checked the way `aai/runtime`'s
 * dead import was: by whoever copies them.
 */
const SOURCE_GLOBS = [
  "packages/aai",
  "packages/aai-runtime",
  "packages/aai-ui",
  "packages/aai-cli",
];

/**
 * Markdown sources users and coding agents read examples from.
 *
 * **The PUBLISHED packages' READMEs are the ones npm renders**, so they
 * are the first examples a new user copies — and they were the one user-facing
 * markdown this list omitted, while the same packages' doc COMMENTS were
 * checked through `SOURCE_GLOBS`. `aai-ui/README.md` had carried
 * `client({ sidebar: <OrderSidebar /> })` for exactly that long: `sidebar` is a
 * `ComponentType`, so the element form is a `TS2322` in the reader's build and
 * in no build of ours. The root README hit the identical mistake and this gate
 * named it there in seconds, which is the argument — the corpus, not the care
 * taken, is what makes the difference.
 *
 * **`docs/home.md` is the published site's landing page** — the first code a
 * visitor to https://alexkroman.github.io/agent/ reads — and it sat outside
 * this list for as long as the list existed. It carried
 * `agent({ …, tools: { get_weather: getWeather } })`, which is not merely
 * wrong: `AgentParams` declares `tools?: InlineToolsMisuse`, a string literal
 * whose text tells the author that a tool is declared by its FILE. So the
 * most-read example in the project taught the exact misuse the type system
 * exists to reject, and contradicted `packages/aai/README.md` on the same
 * screen. Nothing downstream regenerates when it changes — the markdown
 * rendering sets `readme: "none"`, so it reaches `docs/dist` only.
 *
 * **Every runnable example's README belongs here, and only one of the three
 * did.** `examples/host-server/README.md` opens on the whole server in four
 * lines and went on importing `@alexkroman1/aai/runtime` for as long as that
 * subpath had been gone — an `ERR_PACKAGE_PATH_NOT_EXPORTED` for anyone who
 * copied it, in the one file the example exists to be read from.
 * `packages/aai-runtime/README.md` is the same specifier from the other side:
 * a published package README npm renders, carrying the import that replaced
 * it.
 */
const MARKDOWN_FILES = [
  "README.md",
  "docs/home.md",
  "packages/aai/README.md",
  "packages/aai-ui/README.md",
  "packages/aai-cli/README.md",
  "packages/aai-runtime/README.md",
  "packages/aai-templates/scaffold/CLAUDE.md",
  "examples/host-server/README.md",
  "examples/self-hosted-server/README.md",
];

/**
 * Prompt modules whose template literals embed markdown with code fences —
 * prompt text the studio's coding agent treats as ground truth (the main
 * studio guide is the scaffold CLAUDE.md above; these carry the rest, e.g.
 * the fallback guide). Fences arrive escaped (`\`\`\``), so the extractor
 * unescapes before scanning.
 */
const PROMPT_SOURCES = [
  // The main studio guide is the scaffold CLAUDE.md, covered above via
  // MARKDOWN_FILES; these are the other modules that compose prompt text.
  "packages/aai-studio-server/studio-prompt.ts",
  "packages/aai-studio-server/studio-preamble.ts",
  // The preamble's mode-dependent fragments (voice agent vs workflow app).
  // Carries no fence today; listed because it is prompt text, so the first
  // example added to it is checked rather than discovered by a user.
  "packages/aai-studio-server/studio-preamble-mode.ts",
  "packages/aai-studio-server/studio-preamble-sdk.ts",
  "packages/aai-guest/studio-chat.ts",
];

/**
 * Source files of one package, from git rather than a recursive `readdirSync`.
 *
 * The same call the file-length and escape-hatch ratchets use, and for the
 * same reasons: git already knows what is source, so `.gitignore` is honoured
 * for free (the hand-rolled walk needed a SKIP_DIRS list — node_modules, dist,
 * coverage, … — that had to be kept in sync with reality by hand), and
 * `--others --exclude-standard` still includes a new file that has not been
 * committed yet, so a doc example added in the working tree is checked.
 */
function sourceFiles(repo, pkg) {
  // A bare DIRECTORY pathspec, with the extension filter applied in JS. A
  // `${pkg}/**/*.ts` pathspec looks equivalent and is not: it requires at
  // least one directory level, so it silently skips the package-root files
  // (`index.ts`, `internal.ts`) — which dropped this check from 49 examples
  // to 43 while still reporting ✓, since "how many were found" is not
  // something a green run asserts.
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", pkg], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter(
      (p) =>
        // `--cached` lists INDEX entries, so a file deleted in the work tree but
        // not yet staged is still named here — and reading it threw ENOENT,
        // crashing the gate rather than failing it. Any deletion in progress hit
        // this (four frozen contract examples did).
        existsSync(path.join(repo, p)) &&
        /\.tsx?$/.test(p) &&
        !/\.test(-d)?\.tsx?$/.test(p) &&
        !p.includes("/dist/") &&
        !p.includes("/__snapshots__/") &&
        !p.includes("/fixtures/"),
    )
    .map((p) => path.join(repo, p));
}

/**
 * Extract ```ts / ```tsx fences (minus `no-check`) from a markdown string.
 *
 * **An unclosed fence THROWS.** It used to fall off the end of the loop with
 * `open` still set, silently dropping that block and — because a missing
 * backtick also swallows every fence after it — everything below it:
 * demonstrated on a two-example document with one backtick missing, which
 * extracted 1. That is a discovery failure disguised as a smaller corpus, i.e.
 * the exact thing `MIN_EXAMPLES` exists to catch, arriving one document at a
 * time where the floor can only see the total.
 */
function extractFences(text, stripPrefix, origin = "<string>") {
  const blocks = [];
  const lines = text.split("\n");
  let open = null; // { lang, start, body: [] }
  for (let i = 0; i < lines.length; i++) {
    const raw = stripPrefix ? lines[i].replace(/^\s*\*( |$)/, "") : lines[i];
    const fence = raw.match(/^\s*```(\S*)\s*(.*)$/);
    if (!open) {
      // Anything else — a bare fence, a ```sh block, or a ```ts marked
      // `no-check` — is skipped: `open` stays null, so its body is not
      // collected and its closing fence takes this same branch.
      if (fence && /^tsx?$/.test(fence[1]) && !fence[2].includes("no-check")) {
        open = { lang: fence[1], start: i + 1, body: [] };
      }
    } else if (fence) {
      blocks.push({ lang: open.lang, line: open.start + 1, code: open.body.join("\n") });
      open = null;
    } else {
      open.body.push(raw);
    }
  }
  if (open !== null) {
    throw new Error(
      `check-doc-examples: unclosed \`\`\`${open.lang} fence opened at ${origin}:${open.start} — ` +
        "the block and every fence after it would be dropped silently. Close it.",
    );
  }
  return blocks;
}

/** Extract fenced examples from every /** ... *\/ comment in a source file. */
function extractFromSource(text, origin) {
  const blocks = [];
  const re = /\/\*\*[\s\S]*?\*\//g;
  for (const m of text.matchAll(re)) {
    const startLine = text.slice(0, m.index).split("\n").length;
    for (const b of extractFences(m[0], true, origin)) {
      blocks.push({ ...b, line: startLine + b.line - 1 });
    }
  }
  return blocks;
}

const examples = [];
for (const pkg of SOURCE_GLOBS) {
  for (const file of sourceFiles(repo, pkg)) {
    for (const b of extractFromSource(readFileSync(file, "utf-8"), path.relative(repo, file))) {
      examples.push({ ...b, origin: path.relative(repo, file) });
    }
  }
}
for (const md of MARKDOWN_FILES) {
  for (const b of extractFences(readFileSync(path.join(repo, md), "utf-8"), false, md)) {
    examples.push({ ...b, origin: md });
  }
}
for (const src of PROMPT_SOURCES) {
  // Unescape the template-literal escapes (\` and \${) without shifting
  // line numbers, then scan like markdown.
  const text = readFileSync(path.join(repo, src), "utf-8")
    .replaceAll("\\`", "`")
    .replaceAll("\\${", "${");
  for (const b of extractFences(text, false, src)) {
    examples.push({ ...b, origin: src });
  }
}

/**
 * Floor on how many examples the extractor must find, in the same spirit as
 * the coverage floors: a green run says every example it FOUND compiles, and
 * says nothing about how many it should have.
 *
 * Zero was the old floor and it is far too loose to catch the failure that
 * actually happens — a discovery change that quietly stops matching some
 * files. Swapping the recursive walk for `git ls-files` did exactly that
 * twice in one sitting (49 → 17 on a doubled path prefix, then 49 → 43 on a
 * `**` pathspec that skips package-root files), and both runs reported ✓.
 *
 * Set a few below the current actual. Raise it when the real count rises;
 * never lower it to make a run pass — a drop means examples stopped being
 * discovered, which is the bug.
 *
 * The floor once sat at 45 against 98 with the comment still
 * claiming "49 at the time of writing", so more than HALF the corpus could
 * stop being discovered while the gate printed `all N doc examples compile ✓`
 * — a floor two doublings behind its actual is not much better than the zero
 * it replaced. The count is deterministic (same tree, same number), so the
 * margin here is only for fences legitimately deleted, not for run-to-run
 * spread. Re-measure and re-raise when the number moves; the run's own closing
 * line prints it.
 *
 * **MEASURED: 160** — 151 before `aai-runtime` joined `SOURCE_GLOBS` (+7 doc
 * comments) and `aai-runtime`/`host-server`'s READMEs joined `MARKDOWN_FILES`
 * (+2 fences).
 */
const MIN_EXAMPLES = 157;
if (examples.length < MIN_EXAMPLES) {
  console.error(
    `check-doc-examples: extracted only ${examples.length} examples, expected at least ` +
      `${MIN_EXAMPLES}. Either the extractor stopped matching files (check SOURCE_GLOBS, ` +
      "MARKDOWN_FILES and PROMPT_SOURCES), or examples were genuinely removed — in which " +
      "case lower MIN_EXAMPLES deliberately, in the same commit.",
  );
  process.exit(1);
}

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

/** scratch filename → { origin, line } for mapping diagnostics back. */
const manifest = new Map();
examples.forEach((ex, i) => {
  // JSX in a .ts file is a parse error, so anything with JSX gets .tsx.
  const ext = ex.lang === "tsx" || /<[A-Z][^>]*>/.test(ex.code) ? "tsx" : "ts";
  const name = `example-${i}.${ext}`;
  manifest.set(name, ex);
  // `export {}` makes each example its own module, so identically-named
  // consts across examples don't collide in one global scope.
  writeFileSync(path.join(scratch, name), `${ex.code}\nexport {};\n`);
});

let result;
try {
  result = runScaffoldTsc({
    // Per-pid, because two doc-example runs may overlap; the templates gate
    // has no such concurrency and keeps a fixed name.
    name: `doc-examples-${process.pid}`,
    overrides: {
      // `node` only — examples never use vitest globals.
      types: ["node"],
      // Examples routinely end on an import or a declaration the prose picks
      // up — unused-symbol strictness would fight the medium.
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
    include: [path.join(scratch, "*.ts"), path.join(scratch, "*.tsx")],
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (result.ok) {
  console.log(`check-doc-examples: all ${examples.length} doc examples compile. ✓`);
} else {
  // Rewrite scratch paths in diagnostics back to the doc that owns the fence.
  const out = result.output.replace(
    /[^\s(]*\.doc-examples-scratch-\d+\/(example-\d+\.tsx?)/g,
    (_, name) => {
      const ex = manifest.get(name);
      return ex ? `${ex.origin}:${ex.line} (example)` : name;
    },
  );
  process.stdout.write(out);
  console.error(
    "\ncheck-doc-examples: a documentation example does not compile. Examples must be\n" +
      "self-contained (import what they use, declare what they reference). A fence that\n" +
      "is deliberately a fragment opts out with `no-check`: ```ts no-check",
  );
  process.exitCode = 1;
}
