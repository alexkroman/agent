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
  // NOTE the boundaries: `(^|[^A-Za-z0-9_])` / `([^A-Za-z0-9_]|$)`, not `\b`.
  //
  // `\b` is a GNU extension, not POSIX ERE, and git's own matcher does not
  // implement it — on Apple Git 2.50.1 these two patterns matched NOTHING and
  // the gate cheerfully reported `as any base=0 now=0` and `as unknown as
  // base=0 now=0` while the tree held 8 and 110 of them. Both had been dead
  // since the day they were added, so the halving of `as unknown as` that
  // this file's comment celebrates was being enforced by nobody, and a branch
  // adding three more passed clean. Verified by A/B: with `\b`, 0 matches;
  // without it, 110.
  //
  // Do not "simplify" these back to `\b`, and do not drop the boundaries
  // either — a bare `as any` substring would also match `as anything`.
  { label: "as any", re: "(^|[^A-Za-z0-9_])as any([^A-Za-z0-9_]|$)" },
  // The double-cast that launders a value past the type checker without
  // tripping `as any` above. Being uncounted for so long is exactly why it
  // became the dominant hatch idiom here: it peaked at 210 under `packages/`
  // against 3 `as any` (and all three of those are prose in comments, not
  // real casts).
  //
  // Counted since the branch that halved it. The removals were not
  // suppressions moved elsewhere — each concentration got a TYPED SEAM, one
  // narrowing in one helper that every call site then goes through:
  // `fakeOf(session)` in stt/assemblyai.test.ts (35 -> 1),
  // `asSessionWs(ws)` in host-mode.test.ts (13 -> 2),
  // `okFetch().fetch` / `.firstCall()` in ssrf-pinning.test.ts (12 -> 2),
  // `MockWebSocketConstructor` + `recordingWebSocketClass` shared across the
  // aai-ui session-core suites (26 -> 7 for the package). Some vanished
  // outright by using the tool's own affordance instead — `vi.mocked(fn)`, or
  // typing a recorder with `Parameters<T>` so nothing needs widening.
  //
  // Adding this line was always a one-word change; what it needed was a branch
  // where the count does not JUMP. Because the ratchet diffs the work tree
  // against the merge-base with origin/main, enabling it on a branch many
  // commits ahead charges that branch for every cast those commits added (+47
  // when this was first tried). Land such a change directly on top of
  // origin/main, as this one was.
  { label: "as unknown as", re: "(^|[^A-Za-z0-9_])as unknown as([^A-Za-z0-9_]|$)" },
];

// Only count source under packages/ and scripts/, never built output.
// `scripts/` is included for the same reason it is linted: a `biome-ignore`
// added to repo tooling is the same debt as one added to shipped source, and
// leaving it uncounted makes `scripts/` the cheapest place to hide one.
// This file is excluded from its own scan — not as an exemption, but because
// it is the only file whose SOURCE is a list of the patterns. Counting it
// makes the gate self-referential: the six pattern strings in PATTERNS above
// are scored as six hatches, and editing this comment moves the ratchet.
//
// MARKDOWN IS EXCLUDED FOR THAT SAME REASON, and learning it cost a blocked
// release. These patterns are plain substrings with no notion of code versus
// prose, so any doc that *discusses* a hatch is scored as one. `CHANGELOG.md`
// is the sharp edge: changesets renders it from changeset summaries, so the
// summary for #996 — which described fixing this very script's `as any` and
// `as unknown as` patterns — became `packages/aai/CHANGELOG.md:47` and failed
// the Version Packages PR with `+1 as any, +1 as unknown as`. Nothing an
// author could see at review time, on a file no human wrote, blocking every
// release whose changesets happen to name a pattern. The scaffold guide had
// the milder version of the same bug: "the same way as any secret" sat in the
// baseline as a phantom `as any` (which is why this change drops the total by
// one).
//
// The trade-off: a genuine `@ts-expect-error` inside a ```ts doc fence is no
// longer counted. That is deliberate and much the smaller risk — those fences
// are prose examples compiled separately by `check:doc-examples`, whereas the
// false positives above are demonstrated, release-blocking, and unfixable by
// the author who trips them.
const PATHSPECS = [
  "packages",
  "scripts",
  ":!packages/**/dist/**",
  ":!scripts/check-escape-hatches.mjs",
  ":!packages/**/*.md",
  ":!scripts/**/*.md",
];

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

/**
 * Split one `git grep -n` output line into `{ file, line, text }`.
 *
 * With a ref the format is `<ref>:<file>:<line>:<text>`; without one it is
 * `<file>:<line>:<text>`. Slice off the prefixes positionally rather than
 * splitting on ":" — the matched source line very often contains colons.
 */
function parseMatch(raw, ref) {
  const rest = ref ? raw.slice(ref.length + 1) : raw;
  const fileEnd = rest.indexOf(":");
  const lineEnd = rest.indexOf(":", fileEnd + 1);
  return {
    file: rest.slice(0, fileEnd),
    line: Number(rest.slice(fileEnd + 1, lineEnd)),
    text: rest.slice(lineEnd + 1).trim(),
  };
}

/** List lines matching `re`, optionally at a committed ref instead of the work tree. */
function listMatches(re, ref) {
  const args = ["grep", "-nIE"];
  if (!ref) args.push("--untracked");
  args.push("-e", re);
  if (ref) args.push(ref);
  args.push("--", ...PATHSPECS);
  const out = git(args, { allowNoMatch: true });
  if (out === "") return [];
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseMatch(line, ref));
}

/**
 * Work-tree matches that aren't accounted for by a base match.
 *
 * Matched as a MULTISET keyed on `file` + trimmed line text, never on line
 * number: adding an import above an existing hatch shifts every line below it,
 * and reporting those as new would bury the one line that is. Pairing by
 * content means a hatch that only MOVED within its file cancels out, and a
 * second identical hatch in the same file still surfaces (the first claims the
 * base entry, the second has nothing left to pair with).
 */
function newOccurrences(baseMatches, workMatches) {
  const unclaimed = new Map();
  for (const m of baseMatches) {
    const key = `${m.file}\t${m.text}`;
    unclaimed.set(key, (unclaimed.get(key) ?? 0) + 1);
  }
  const added = [];
  for (const m of workMatches) {
    const key = `${m.file}\t${m.text}`;
    const left = unclaimed.get(key) ?? 0;
    if (left > 0) unclaimed.set(key, left - 1);
    else added.push(m);
  }
  return added;
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
  console.log("check-hatches: no origin/main to compare against — skipping ratchet.");
  process.exit(0);
}

let baseTotal = 0;
let workTotal = 0;
const rows = [];
for (const { label, re } of PATTERNS) {
  const baseMatches = listMatches(re, base);
  const workMatches = listMatches(re, null);
  const baseN = baseMatches.length;
  const workN = workMatches.length;
  baseTotal += baseN;
  workTotal += workN;
  rows.push({
    label,
    baseN,
    workN,
    delta: workN - baseN,
    added: newOccurrences(baseMatches, workMatches),
  });
}

const width = Math.max(...PATTERNS.map((p) => p.label.length));
console.log(`check-hatches: escape hatches vs ${base.slice(0, 12)}\n`);
for (const { label, baseN, workN, delta } of rows) {
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  console.log(`  ${label.padEnd(width)}  base=${baseN}  now=${workN}  (${sign})`);
}
console.log(`  ${"TOTAL".padEnd(width)}  base=${baseTotal}  now=${workTotal}`);

// Cap the per-pattern listing. A branch that trips this by hundreds does not
// need hundreds of lines to know what it did, and the count above already
// carries the magnitude.
const MAX_SHOWN = 20;
const MAX_TEXT = 100;

if (workTotal > baseTotal) {
  const grown = rows.filter((r) => r.delta > 0);
  const added = grown.map((r) => `${r.label} (+${r.delta})`);
  console.error(
    `\ncheck-hatches: ${workTotal - baseTotal} net-new escape hatch(es) ` +
      `introduced: ${added.join(", ")}.`,
  );
  // Counts alone leave you diffing against the merge base by hand to find the
  // line you just added, which is the whole of the work this gate asks for.
  for (const { label, added: occurrences } of grown) {
    if (occurrences.length === 0) continue;
    console.error(`\n  ${label}:`);
    for (const { file, line, text } of occurrences.slice(0, MAX_SHOWN)) {
      const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
      console.error(`    ${file}:${line}  ${shown}`);
    }
    if (occurrences.length > MAX_SHOWN) {
      console.error(`    … and ${occurrences.length - MAX_SHOWN} more`);
    }
  }
  console.error(
    "\nRemove the new suppression(s), or fix the underlying type/lint error " +
      "instead of silencing it. The baseline only ratchets down.",
  );
  process.exit(1);
}

console.log("\ncheck-hatches: no net-new escape hatches. ✓");
