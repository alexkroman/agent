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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT as repo, runScaffoldTsc } from "./_scaffold-tsc.mjs";

// Inside aai-templates so bare imports (`@alexkroman1/aai`, `zod`, react)
// resolve by the normal node_modules walk-up, exactly as templates do.
const scratch = path.join(repo, `packages/aai-templates/.doc-examples-scratch-${process.pid}`);

/** Doc-comment sources: published packages' source trees. */
const SOURCE_GLOBS = ["packages/aai", "packages/aai-ui", "packages/aai-cli"];

/** Markdown sources users and coding agents read examples from. */
const MARKDOWN_FILES = [
  "README.md",
  "packages/aai-templates/scaffold/CLAUDE.md",
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
        /\.tsx?$/.test(p) &&
        !/\.test(-d)?\.tsx?$/.test(p) &&
        !p.includes("/dist/") &&
        !p.includes("/__snapshots__/") &&
        !p.includes("/fixtures/"),
    )
    .map((p) => path.join(repo, p));
}

/** Extract ```ts / ```tsx fences (minus `no-check`) from a markdown string. */
function extractFences(text, stripPrefix) {
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
  return blocks;
}

/** Extract fenced examples from every /** ... *\/ comment in a source file. */
function extractFromSource(text) {
  const blocks = [];
  const re = /\/\*\*[\s\S]*?\*\//g;
  for (const m of text.matchAll(re)) {
    const startLine = text.slice(0, m.index).split("\n").length;
    for (const b of extractFences(m[0], true)) {
      blocks.push({ ...b, line: startLine + b.line - 1 });
    }
  }
  return blocks;
}

const examples = [];
for (const pkg of SOURCE_GLOBS) {
  for (const file of sourceFiles(repo, pkg)) {
    for (const b of extractFromSource(readFileSync(file, "utf-8"))) {
      examples.push({ ...b, origin: path.relative(repo, file) });
    }
  }
}
for (const md of MARKDOWN_FILES) {
  for (const b of extractFences(readFileSync(path.join(repo, md), "utf-8"), false)) {
    examples.push({ ...b, origin: md });
  }
}
for (const src of PROMPT_SOURCES) {
  // Unescape the template-literal escapes (\` and \${) without shifting
  // line numbers, then scan like markdown.
  const text = readFileSync(path.join(repo, src), "utf-8")
    .replaceAll("\\`", "`")
    .replaceAll("\\${", "${");
  for (const b of extractFences(text, false)) {
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
 * Set a few below the current actual (49 at the time of writing). Raise it
 * when the real count rises; never lower it to make a run pass — a drop means
 * examples stopped being discovered, which is the bug.
 */
const MIN_EXAMPLES = 45;
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
