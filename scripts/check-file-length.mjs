#!/usr/bin/env node

/**
 * Max-file-length gate.
 *
 * Long files are where complexity hides and where reviewers stop reading.
 * This gate caps source and test files at a fixed line count, with a
 * grandfather allowlist (`file-length-allowlist.json`) for the handful of
 * files that already exceed the cap today.
 *
 * The allowlist is a ratchet: each entry records the file's *current*
 * ceiling, and the file may not grow past it. As files get split up the
 * ceilings should be lowered (or entries removed) — never raised. New files
 * have no entry and must come in under the cap from day one.
 *
 * Templates (`packages/aai-templates/templates/`) are exempt: they are
 * self-contained demo agents, not library code, and are already exempt from
 * many lint rules in biome.json.
 *
 * Inspired by the 500-line gate in AssemblyAI/cli's scripts/check.sh.
 *
 * Wired up as `pnpm check:file-length`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Caps. Tests get more headroom — exhaustive cases legitimately run long.
const SOURCE_MAX = 500;
const TEST_MAX = 700;

const allowlist = JSON.parse(
  readFileSync(join(ROOT, "scripts", "file-length-allowlist.json"), "utf8"),
);

const isTest = (path) => /\.test\.tsx?$|\.test-d\.ts$|_test-utils\.ts$|test-utils\.ts$/.test(path);
const isExempt = (path) => path.startsWith("packages/aai-templates/templates/");

/** Count lines the way `wc -l` does: one per newline, ignoring a trailing newline. */
const countLines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

// `--others --exclude-standard` includes new, not-yet-committed files (but
// not gitignored ones) so a freshly-added oversized file is caught too.
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "packages/**/*.ts",
    "packages/**/*.tsx",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\n")
  .filter((p) => p.length > 0 && !p.includes("/dist/") && !isExempt(p));

const violations = [];
const staleAllowlist = [];
const seen = new Set();

for (const path of files) {
  const lines = countLines(readFileSync(join(ROOT, path), "utf8"));
  const cap = isTest(path) ? TEST_MAX : SOURCE_MAX;

  if (path in allowlist) {
    seen.add(path);
    const ceiling = allowlist[path];
    if (lines > ceiling) {
      violations.push(
        `${path}: ${lines} lines exceeds its grandfathered ceiling of ${ceiling}. ` +
          "This file may not grow further — split it up.",
      );
    } else if (lines <= cap) {
      staleAllowlist.push(
        `${path}: now ${lines} lines (under the ${cap}-line cap) — remove it from ` +
          "file-length-allowlist.json.",
      );
    }
    continue;
  }

  if (lines > cap) {
    violations.push(
      `${path}: ${lines} lines exceeds the ${cap}-line cap for ${isTest(path) ? "test" : "source"} files. ` +
        "Split it into focused modules.",
    );
  }
}

// Flag allowlist entries that no longer point at a real file.
for (const path of Object.keys(allowlist)) {
  if (path.startsWith("_")) continue;
  if (!seen.has(path)) {
    staleAllowlist.push(
      `${path}: listed in file-length-allowlist.json but not found — remove the stale entry.`,
    );
  }
}

if (violations.length > 0) {
  console.error("check-file-length: file(s) over the line cap:\n");
  for (const v of violations) console.error(`  - ${v}`);
  if (staleAllowlist.length > 0) {
    console.error("\ncheck-file-length: also tidy these allowlist entries:\n");
    for (const s of staleAllowlist) console.error(`  - ${s}`);
  }
  process.exit(1);
}

if (staleAllowlist.length > 0) {
  console.error("check-file-length: stale allowlist entries (ratchet them down):\n");
  for (const s of staleAllowlist) console.error(`  - ${s}`);
  process.exit(1);
}

console.log(
  `check-file-length: all files within caps (source ${SOURCE_MAX}, test ${TEST_MAX}). ✓`,
);
