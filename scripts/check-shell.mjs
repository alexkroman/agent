#!/usr/bin/env node

/**
 * ShellCheck over every tracked shell script.
 *
 * Biome reads no shell, and the scripts here run in the places a quoting bug
 * costs most: `.claude/hooks/session-start.sh` provisions every cloud session,
 * `scripts/create-changeset.sh` writes release notes. Nothing linted them.
 *
 * WHAT is linted is `git ls-files`: every `*.sh`, plus any extensionless file
 * whose first line is a `sh`/`bash` shebang — so a new script is covered the
 * moment it is committed, with no list to keep current.
 *
 * ShellCheck is a Haskell binary with no pnpm-installable build that pins its
 * version (the `shellcheck` npm wrapper downloads `latest` from GitHub at first
 * run), so it is taken from PATH — `SHELLCHECK` overrides the path. GitHub's
 * `ubuntu-latest` image ships it. A missing binary is ANNOUNCED and skipped
 * locally, and a FAILURE under `AAI_REQUIRE_SHELLCHECK=1`, which CI sets: the
 * same shape as `AAI_REQUIRE_PG`, so the one place that must run the check
 * cannot skip it silently.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GATE = "check:shell";
const SHEBANG = /^#!.*\b(?:sh|bash)\b/;
const bin = process.env.SHELLCHECK || "shellcheck";
/** Measured 2026-09: 3 (`.claude/hooks/session-start.sh`, two in `scripts/`). */
const MIN_SCRIPTS = 3;

/** Every tracked shell script, repo-relative. */
function shellScripts() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return tracked.filter((file) => {
    if (file.endsWith(".sh")) return true;
    if (/\.[^/]+$/.test(file)) return false;
    try {
      return SHEBANG.test(readFileSync(file, "utf8").split("\n", 1)[0] ?? "");
    } catch {
      // A tracked path deleted in the working tree has nothing to lint.
      return false;
    }
  });
}

const probe = spawnSync(bin, ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  const hint =
    "install it (`brew install shellcheck`, `apt-get install shellcheck`) or set SHELLCHECK";
  if (process.env.AAI_REQUIRE_SHELLCHECK === "1") {
    console.error(`${GATE}: \`${bin}\` not found, and AAI_REQUIRE_SHELLCHECK=1 — ${hint}`);
    process.exit(1);
  }
  console.warn(`${GATE}: SKIPPED — \`${bin}\` not found; ${hint}`);
  process.exit(0);
}

const files = shellScripts();
if (files.length < MIN_SCRIPTS) {
  console.error(
    `${GATE}: found ${files.length} shell script(s), under the floor of ${MIN_SCRIPTS} — ` +
      "the discovery is broken, or scripts were deleted (lower MIN_SCRIPTS with them)",
  );
  process.exit(1);
}

const result = spawnSync(bin, ["--external-sources", ...files], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`${GATE}: ${files.length} script(s) clean`);
