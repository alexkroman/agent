#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * Every page of the narrative docs site is listed in `MARKDOWN_FILES`.
 *
 * That list has to be LITERAL — both doc-example gate specs read it by
 * scraping `check-doc-examples.mjs` for string literals (see
 * `packages/aai-gates/src/_doc-example-corpus.ts`), so a spread or a computed
 * entry makes the pages invisible to them. A hand-kept list of a growing
 * directory is then exactly the shape this repo has already paid for twice, so
 * the directory is resolved here and compared against it: add a page and
 * forget to list it, and the gate fails naming the file rather than quietly
 * checking one fewer document.
 *
 * It lives beside the gate rather than inside it because the gate is at its
 * 500-line cap, and this check is the part with no reason to be read while
 * following the compile pipeline.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Where the site's content collection lives, repo-relative. */
const DOCS_PAGES_DIR = "docs/src/content/docs";

/**
 * Exit non-zero, naming the pages, if any is missing from `listed`.
 *
 * `git ls-files --cached --others --exclude-standard` rather than a walk, for
 * the same reasons the gate's own `sourceFiles` gives: `.gitignore` is honoured
 * for free, and a page added in the working tree is checked before it is
 * committed. `existsSync` drops a deletion staged but not yet written.
 *
 * @param {string} repo Absolute path to the repository root.
 * @param {readonly string[]} listed The gate's `MARKDOWN_FILES`.
 */
export function assertEveryDocsPageListed(repo, listed) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", DOCS_PAGES_DIR],
    { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const onDisk = out.split("\n").filter((p) => /\.mdx?$/.test(p) && existsSync(path.join(repo, p)));
  const known = new Set(listed);
  const missing = onDisk.filter((p) => !known.has(p));
  if (missing.length === 0) return;
  console.error(
    `check-doc-examples: ${missing.length} docs page(s) are not in MARKDOWN_FILES, so ` +
      `their examples compile under no gate:\n  ${missing.join("\n  ")}`,
  );
  process.exit(1);
}
