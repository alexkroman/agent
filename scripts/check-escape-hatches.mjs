#!/usr/bin/env node

/**
 * Escape-hatch ratchet, against a COMMITTED PER-FILE BASELINE.
 *
 * Static-analysis escape hatches (`@ts-expect-error`, `as any`,
 * `biome-ignore`, ...) silence the very checks the rest of this repo's `check`
 * pipeline works to enforce. Each one is a small, often permanent, hole in the
 * type/lint safety net. We can't realistically delete the ones that already
 * exist in one pass, but we can stop the bleeding.
 *
 * `escape-hatch-baseline.json` records, per pattern, how many occurrences each
 * file is allowed. A file may hold fewer; a file may never hold more; a file
 * absent from the baseline may hold none. Counts only ever come DOWN.
 *
 * ## Why per-file, and not the grand total this used to compare
 *
 * The previous version diffed the work tree against the merge-base with
 * `origin/main` and compared GRAND TOTALS. Three things were wrong with that,
 * and all three were documented as known weaknesses rather than fixed:
 *
 *   1. **Totals let a branch trade.** Removing four hatches in one file bought
 *      headroom to add four somewhere else, silently. The comment called this
 *      deliberate ("it lets a refactor swap one for another") but the cost is
 *      that a large-reduction branch does not police itself at all — and the
 *      reduction only became the floor once it landed and became the next
 *      branch's merge base. A per-file count cannot be traded across files.
 *
 *   2. **A stale branch was charged for its ancestors.** Because the diff was
 *      against the merge base, enabling a new pattern on a branch many commits
 *      ahead charged that branch for every occurrence those commits added — +47
 *      when `as unknown as` was first tried. The standing advice was "land a
 *      new pattern directly on top of origin/main", i.e. work around the gate.
 *      A committed baseline has no merge base and no such rule.
 *
 *   3. **No `origin/main` meant NO GATE.** `resolveBase()` returned null in a
 *      shallow clone or a fresh worktree and the script exited 0 with
 *      "skipping ratchet" — the one shape of failure this repo has been bitten
 *      by repeatedly, a gate that reports success while checking nothing. The
 *      baseline is a file in the tree, so the check runs identically with no
 *      remotes, no history, and no network.
 *
 * The cost is bookkeeping: removing a hatch means lowering a number here.
 * `--update` does that for you and REFUSES to raise anything, so the honest
 * path is one command and the dishonest one requires hand-editing JSON in a
 * diff a reviewer can see.
 *
 * Inspired by the Python CLI's `# type: ignore | # noqa | pragma: no cover`
 * ratchet in AssemblyAI/cli's scripts/check.sh, and by the per-file baselines
 * in vercel/eve's `scripts/guard-invariants-baseline.json`.
 *
 * Wired up as `pnpm check:hatches`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE_PATH = new URL("escape-hatch-baseline.json", import.meta.url);

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
  { label: "as unknown as", re: "(^|[^A-Za-z0-9_])as unknown as([^A-Za-z0-9_]|$)" },
];

// Only count source under packages/ and scripts/, never built output.
// `scripts/` is included for the same reason it is linted: a `biome-ignore`
// added to repo tooling is the same debt as one added to shipped source, and
// leaving it uncounted makes `scripts/` the cheapest place to hide one.
// This file is excluded from its own scan — not as an exemption, but because
// it is the only file whose SOURCE is a list of the patterns. Counting it
// makes the gate self-referential: the seven pattern strings in PATTERNS above
// are scored as seven hatches, and editing this comment moves the ratchet.
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
// baseline as a phantom `as any`.
//
// The trade-off: a genuine `@ts-expect-error` inside a ```ts doc fence is no
// longer counted. That is deliberate and much the smaller risk — those fences
// are prose examples compiled separately by `check:doc-examples`, whereas the
// false positives above are demonstrated, release-blocking, and unfixable by
// the author who trips them.
//
// `escape-hatch-baseline.json` is excluded for the SAME reason as this script,
// and it earned the line immediately: moving to a per-file baseline created a
// second file whose content is a list of the pattern names, so the first run
// scored its own `"as unknown as": { ... }` keys as four fresh hatches. It is
// the self-referential trap described above, arriving by a new route.
const PATHSPECS = [
  "packages",
  "scripts",
  ":!packages/**/dist/**",
  ":!scripts/check-escape-hatches.mjs",
  ":!scripts/escape-hatch-baseline.json",
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
 * The format is `<file>:<line>:<text>`. Slice off the prefixes positionally
 * rather than splitting on ":" — the matched source line very often contains
 * colons.
 */
function parseMatch(raw) {
  const fileEnd = raw.indexOf(":");
  const lineEnd = raw.indexOf(":", fileEnd + 1);
  return {
    file: raw.slice(0, fileEnd),
    line: Number(raw.slice(fileEnd + 1, lineEnd)),
    text: raw.slice(lineEnd + 1).trim(),
  };
}

/**
 * Every work-tree line matching `re`.
 *
 * `--untracked` so a hatch in a brand-new, not-yet-added file is counted —
 * otherwise `git add` is all it takes to defer the gate to a later commit.
 */
function listMatches(re) {
  const out = git(["grep", "-nIE", "--untracked", "-e", re, "--", ...PATHSPECS], {
    allowNoMatch: true,
  });
  if (out === "") return [];
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseMatch);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

/** Per-pattern `{ file: count }` for the current work tree. */
const actual = new Map();
/** Per-pattern `file -> matches[]`, so a failure can name lines. */
const occurrences = new Map();

for (const { label, re } of PATTERNS) {
  const byFile = new Map();
  const linesByFile = new Map();
  for (const match of listMatches(re)) {
    byFile.set(match.file, (byFile.get(match.file) ?? 0) + 1);
    linesByFile.set(match.file, [...(linesByFile.get(match.file) ?? []), match]);
  }
  actual.set(label, byFile);
  occurrences.set(label, linesByFile);
}

// ---------------------------------------------------------------------------
// --update: lower the baseline to match reality. Never raise it.
// ---------------------------------------------------------------------------

if (process.argv.includes("--update")) {
  const next = { _description: baseline._description };
  const lowered = [];
  const refused = [];

  for (const { label } of PATTERNS) {
    const allowed = baseline[label] ?? {};
    const current = actual.get(label) ?? new Map();
    const merged = {};

    for (const file of new Set([...Object.keys(allowed), ...current.keys()])) {
      const was = allowed[file] ?? 0;
      const now = current.get(file) ?? 0;
      if (now > was) {
        // The whole point of the ratchet. `--update` is a convenience for
        // recording removals, not a way to bless additions — otherwise the
        // gate would be advisory and one command would silence it.
        refused.push({ label, file, was, now });
        if (was > 0) merged[file] = was;
        continue;
      }
      if (now < was) lowered.push({ label, file, was, now });
      if (now > 0) merged[file] = now;
    }

    if (Object.keys(merged).length > 0) {
      next[label] = Object.fromEntries(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
  }

  if (refused.length > 0) {
    console.error(`\ncheck-hatches --update: refusing to RAISE ${refused.length} entr(ies):\n`);
    for (const { label, file, was, now } of refused) {
      console.error(`  ${label}  ${file}  ${was} -> ${now}`);
    }
    console.error(
      "\nThe baseline only ratchets down. Fix the underlying type/lint error\n" +
        "instead of silencing it. If a suppression is genuinely unavoidable, raise\n" +
        "the number by hand so the increase shows up in the diff and gets reviewed.\n",
    );
    process.exit(1);
  }

  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  if (lowered.length === 0) {
    console.log("check-hatches --update: baseline already matches the work tree.");
  } else {
    console.log(`check-hatches --update: lowered ${lowered.length} entr(ies):\n`);
    for (const { label, file, was, now } of lowered) {
      console.log(`  ${label}  ${file}  ${was} -> ${now}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

/** Cap the per-pattern listing — the counts already carry the magnitude. */
const MAX_SHOWN = 20;
const MAX_TEXT = 100;

const violations = [];
/** Entries the tree is now UNDER — free headroom that should be given back. */
const stale = [];
let allowedTotal = 0;
let actualTotal = 0;

for (const { label } of PATTERNS) {
  const allowed = baseline[label] ?? {};
  const current = actual.get(label) ?? new Map();

  for (const [file, count] of current) {
    const budget = allowed[file] ?? 0;
    if (count > budget) {
      violations.push({ label, file, budget, count });
    }
  }
  for (const [file, budget] of Object.entries(allowed)) {
    const count = current.get(file) ?? 0;
    if (count < budget) stale.push({ label, file, budget, count });
  }

  allowedTotal += Object.values(allowed).reduce((sum, n) => sum + n, 0);
  actualTotal += [...current.values()].reduce((sum, n) => sum + n, 0);
}

const width = Math.max(...PATTERNS.map((p) => p.label.length));
console.log("check-hatches: escape hatches vs escape-hatch-baseline.json\n");
for (const { label } of PATTERNS) {
  const allowed = Object.values(baseline[label] ?? {}).reduce((sum, n) => sum + n, 0);
  const count = [...(actual.get(label) ?? new Map()).values()].reduce((sum, n) => sum + n, 0);
  const delta = count - allowed;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  console.log(`  ${label.padEnd(width)}  allowed=${allowed}  now=${count}  (${sign})`);
}
console.log(`  ${"TOTAL".padEnd(width)}  allowed=${allowedTotal}  now=${actualTotal}`);

if (violations.length > 0) {
  console.error(`\ncheck-hatches: ${violations.length} file(s) over their baseline:\n`);
  for (const { label, file, budget, count } of violations) {
    console.error(`  ${label}  ${file}  allowed ${budget}, found ${count}`);
    const lines = occurrences.get(label)?.get(file) ?? [];
    for (const { line, text } of lines.slice(0, MAX_SHOWN)) {
      const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
      console.error(`      ${file}:${line}  ${shown}`);
    }
    if (lines.length > MAX_SHOWN) console.error(`      … and ${lines.length - MAX_SHOWN} more`);
  }
  console.error(
    "\nFix the underlying type/lint error instead of silencing it. If a\n" +
      "suppression is genuinely unavoidable, raise the number in\n" +
      "scripts/escape-hatch-baseline.json by hand and say why in the PR — the\n" +
      "increase then shows up in the diff. `--update` will not do it for you.\n",
  );
  process.exit(1);
}

// Not a failure. Reclaiming headroom is the ratchet working, and the author who
// removed a hatch should not be blocked for not having also run --update. But
// unclaimed headroom is a hatch the NEXT branch can add for free, which is the
// slow leak that makes a ratchet stop ratcheting.
if (stale.length > 0) {
  console.warn(
    `\ncheck-hatches: ${stale.length} baseline entr(ies) now sit above the real count — ` +
      "run `node scripts/check-escape-hatches.mjs --update` to give the headroom back:\n",
  );
  for (const { label, file, budget, count } of stale.slice(0, MAX_SHOWN)) {
    console.warn(`  ${label}  ${file}  ${budget} -> ${count}`);
  }
  if (stale.length > MAX_SHOWN) console.warn(`  … and ${stale.length - MAX_SHOWN} more`);
}

console.log("\ncheck-hatches: every file within its baseline. ✓");
