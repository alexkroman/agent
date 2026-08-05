#!/usr/bin/env node

/**
 * Escape-hatch ratchet.
 *
 * Static-analysis escape hatches (`@ts-expect-error`, `as any`,
 * `biome-ignore`, ...) silence the very checks the rest of this repo's
 * `check` pipeline works to enforce. Each one is a small, often permanent,
 * hole in the type/lint safety net. We can't realistically delete the ones
 * that already exist in one pass, but we can stop the bleeding: this gate
 * fails when a branch introduces *net-new* escape hatches versus its
 * merge-base with `origin/main`.
 *
 * The count only ratchets downward over time — removing a hatch lowers the
 * baseline for the next branch, and there is no way to silently add one.
 * Refactors that swap one hatch for another (or move code around) don't
 * trip the gate because we compare the grand total, not per-file locations.
 *
 * Inspired by the Python CLI's `# type: ignore | # noqa | pragma: no cover`
 * ratchet in AssemblyAI/cli's scripts/check.sh.
 *
 * Wired up as `pnpm check:hatches`.
 */

import { execFileSync } from "node:child_process";

// Each pattern is an extended-regex (`git grep -E`) so it works on every git
// build. Keep these conservative — only match genuine escape hatches.
const PATTERNS = [
  { label: "@ts-expect-error", re: "@ts-expect-error" },
  { label: "@ts-ignore", re: "@ts-ignore" },
  { label: "@ts-nocheck", re: "@ts-nocheck" },
  { label: "biome-ignore", re: "biome-ignore" },
  { label: "eslint-disable", re: "eslint-disable" },
  { label: "as any", re: "\\bas any\\b" },
  // NOT YET COUNTED, deliberately: `as unknown as T`. It is the double-cast
  // that launders a value past the type checker without tripping `as any`
  // above, and being uncounted is why it became the dominant hatch idiom here
  // — measured 2026-08, there are 198 of them under packages/ (173 in test
  // files) against 3 `as any`. So it belongs in this list.
  //
  // Adding the line is a one-word change; what it needs is a branch where the
  // count does not JUMP. Because the ratchet diffs the work tree against the
  // merge-base with origin/main, enabling it on a branch that is many commits
  // ahead charges that branch for every cast those commits added (+47 when
  // this was tried), so the gate fails for debt the diff never introduced.
  // Land it either directly on top of origin/main, or together with enough
  // removals to cover the delta. The three worst concentrations are the
  // provider suites' `session._transcriber as unknown as Fake…` (27 in
  // stt/assemblyai.test.ts alone), ssrf-pinning.test.ts's mock-fetch casts
  // (12), and host-mode.test.ts's `ws as unknown as SessionWebSocket` (8) —
  // each of which wants a typed seam rather than a cast at every call site.
];

// Only count source under packages/, never built output.
const PATHSPECS = ["packages", ":!packages/**/dist/**"];

/** Run git, returning stdout. Throws on real failure (not "no matches"). */
function git(args, { allowNoMatch = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // git grep exits 1 when there are simply no matches — not an error.
    if (allowNoMatch && err.status === 1) return "";
    throw err;
  }
}

/** Count lines matching `re`, optionally at a committed ref instead of the work tree. */
function countMatches(re, ref) {
  const args = ["grep", "-hIE"];
  if (!ref) args.push("--untracked");
  args.push("-e", re);
  if (ref) args.push(ref);
  args.push("--", ...PATHSPECS);
  const out = git(args, { allowNoMatch: true });
  if (out === "") return 0;
  return out.split("\n").filter((line) => line.length > 0).length;
}

function resolveBase() {
  // Prefer the merge-base with origin/main so long-lived branches aren't
  // penalised for debt that landed on main after they forked.
  try {
    return git(["merge-base", "origin/main", "HEAD"]).trim();
  } catch {
    // Fall back to origin/main directly if it exists.
    try {
      git(["rev-parse", "--verify", "origin/main"]);
      return "origin/main";
    } catch {
      return null;
    }
  }
}

const base = resolveBase();
if (!base) {
  console.log(
    "check-hatches: no origin/main to compare against — skipping ratchet.",
  );
  process.exit(0);
}

let baseTotal = 0;
let workTotal = 0;
const rows = [];
for (const { label, re } of PATTERNS) {
  const baseN = countMatches(re, base);
  const workN = countMatches(re, null);
  baseTotal += baseN;
  workTotal += workN;
  rows.push({ label, baseN, workN, delta: workN - baseN });
}

const width = Math.max(...PATTERNS.map((p) => p.label.length));
console.log(`check-hatches: escape hatches vs ${base.slice(0, 12)}\n`);
for (const { label, baseN, workN, delta } of rows) {
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  console.log(`  ${label.padEnd(width)}  base=${baseN}  now=${workN}  (${sign})`);
}
console.log(`  ${"TOTAL".padEnd(width)}  base=${baseTotal}  now=${workTotal}`);

if (workTotal > baseTotal) {
  const added = rows.filter((r) => r.delta > 0).map((r) => `${r.label} (+${r.delta})`);
  console.error(
    `\ncheck-hatches: ${workTotal - baseTotal} net-new escape hatch(es) ` +
      `introduced: ${added.join(", ")}.\n` +
      "Remove the new suppression(s), or fix the underlying type/lint error " +
      "instead of silencing it. The baseline only ratchets down.",
  );
  process.exit(1);
}

console.log("\ncheck-hatches: no net-new escape hatches. ✓");
