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
 * The ratchet MACHINERY — the scan, the corpus floor, the `--update`
 * merge/refuse, the violations-and-stale reporting — lives in `_ratchet.mjs`,
 * shared with `guard-invariants.mjs`, which is the same machine with different
 * patterns. What stays here is what makes this gate this gate: the patterns, the
 * scope, and the reasoning behind both.
 *
 * Wired up as `pnpm check:hatches`.
 */

import { readFileSync } from "node:fs";

import {
  assertNotUniversallyEmpty,
  assertScanCorpus,
  compareToBaseline,
  isCommentOnly,
  scanGroups,
  totalOf,
  updateBaseline,
  warnStale,
} from "./_ratchet.mjs";

const BASELINE_PATH = new URL("escape-hatch-baseline.json", import.meta.url);

const GATE = "check-hatches";
const UPDATE_COMMAND = "node scripts/check-escape-hatches.mjs --update";

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
  // STRICTLY WORSE than the cast above, and uncounted for even longer. `never`
  // is assignable to everything, so `{ … } as never` passes any parameter
  // position at all — and like `as unknown as` it stops reporting the moment a
  // field is ADDED to the type it is standing in for, which is the whole
  // failure a cast-free builder exists to prevent.
  //
  // It is the DOMINANT type-laundering idiom in this repo's tests: 110
  // occurrences in test files against 62 of the counted `as unknown as`, and
  // between 2026-08-12 and 2026-08-15 it went 98 -> 110 while the counted
  // pattern went 63 -> 62. Uncounted patterns grow; that is the argument for
  // counting this one, and the campaign to remove them is the same one that
  // halved `as unknown as` — a TYPED SEAM per concentration, not a cast per
  // assertion. The two worst are `web-search.test.ts` (13 `{} as never` for a
  // `ToolContext` that already has a builder at `host/_test-utils.ts`) and
  // `runtime-transport.test.ts` (13 on whole options objects, so a renamed or
  // newly required option on the very builder under test compiles silently).
  { label: "as never", re: "(^|[^A-Za-z0-9_])as never([^A-Za-z0-9_]|$)" },
];

/**
 * Patterns whose hit on a COMMENT-ONLY line is prose, not a hatch.
 *
 * The header above spends 25 lines on precisely this hazard — "these patterns
 * are plain substrings with no notion of code versus prose" — and fixed it for
 * MARKDOWN only. `guard-invariants` had solved the general case all along, with
 * a per-rule `skipComments` flag passed as a filter into the shared engine, and
 * this gate called the same `scanGroups` with no filter at all.
 *
 * Measured before the fix: of 119 counted hatches, 25 sat on comment-only
 * lines. Twenty-one of those are CORRECT — a `biome-ignore` genuinely IS a
 * comment, and suppressing the rule is what the comment does — which is why
 * this is a per-pattern set and not a blanket filter. But all four CAST hits on
 * comment lines were prose, and two of them were the ENTIRE `as any` budget
 * (`agent-tools.ts` and `agent-tools.test.ts`, both JSDoc sentences). So a real
 * `export const smuggled = (globalThis as any).x;` could move into that budget
 * with the gate still printing `as any allowed=2 now=2 … every file within its
 * baseline ✓`. Demonstrated on the real gate.
 *
 * Keyed by LABEL rather than carried as a third field on the entries above,
 * because `escape-hatch-scope.test.ts` parses `{ label: "…", re: "…" }` out of
 * this source as an exact shape — one more key in the literal makes it parse
 * zero patterns.
 */
const SKIP_COMMENTS = new Set(["as any", "as unknown as", "as never"]);

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
//
// `:!scripts/*.md` sits beside `:!scripts/**/*.md` and is not redundant, which
// is the fnmatch trap `check-file-length.mjs` spends ten lines on: a git
// pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so the `*` in `scripts/**/*.md`
// already crosses `/` and the LITERAL SLASH after it makes a subdirectory
// mandatory. That glob therefore excluded nothing at the `scripts/` top level.
// Latent only because there is no `scripts/README.md` today — adding one would
// have re-opened the release-blocking CHANGELOG bug above, in the one directory
// where the release notes are least likely to be looked for. `packages/**/*.md`
// is unaffected and not by luck: every markdown file under `packages/` is at
// least one directory deep. Verify either with `git ls-files "<glob>"`, never by
// reading it.
const PATHSPECS = [
  "packages",
  "scripts",
  ":!packages/**/dist/**",
  ":!scripts/check-escape-hatches.mjs",
  ":!scripts/escape-hatch-baseline.json",
  ":!packages/**/*.md",
  ":!scripts/**/*.md",
  ":!scripts/*.md",
];

/**
 * The floor under the scan. ~1,530 files are in scope today.
 *
 * See `_ratchet.mjs` for why the floor is on the CORPUS and not on the match
 * count: this is a debt ratchet whose goal is zero, so a minimum number of
 * matches would eventually block the campaign the gate exists to encourage.
 */
const MIN_SCANNED_FILES = 800;

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

assertScanCorpus({
  gate: GATE,
  what: "the escape-hatch scan",
  pathspecs: PATHSPECS,
  minFiles: MIN_SCANNED_FILES,
});

const groups = PATTERNS.map(({ label, re }) => ({
  key: label,
  label,
  re,
  paths: PATHSPECS,
  skipComments: SKIP_COMMENTS.has(label),
}));
const { counts: actual, occurrences } = scanGroups(groups, {
  filter: (match, group) => !(group.skipComments && isCommentOnly(match.text)),
});

// ---------------------------------------------------------------------------
// --update: lower the baseline to match reality. Never raise it.
// ---------------------------------------------------------------------------

if (process.argv.includes("--update")) {
  updateBaseline({
    gate: GATE,
    baselinePath: BASELINE_PATH,
    baseline,
    groups,
    counts: actual,
    advice:
      "The baseline only ratchets down. Fix the underlying type/lint error\n" +
      "instead of silencing it. If a suppression is genuinely unavoidable, raise\n" +
      "the number by hand so the increase shows up in the diff and gets reviewed.",
  });
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

/** Cap the per-pattern listing — the counts already carry the magnitude. */
const MAX_SHOWN = 20;
const MAX_TEXT = 100;

const {
  violations,
  stale,
  allowedTotal,
  currentTotal: actualTotal,
} = compareToBaseline(groups, baseline, actual);

const width = Math.max(...PATTERNS.map((p) => p.label.length));
console.log("check-hatches: escape hatches vs escape-hatch-baseline.json\n");
for (const { label } of PATTERNS) {
  const allowed = totalOf(baseline[label]);
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

// Every pattern at zero against a non-empty baseline is a blind scan until
// proven otherwise — see `_ratchet.mjs`. It sits AFTER the violation report so a
// genuine failure is still what a reader sees first.
assertNotUniversallyEmpty({
  gate: GATE,
  allowedTotal,
  currentTotal: actualTotal,
  updateCommand: UPDATE_COMMAND,
});

// Not a failure. Reclaiming headroom is the ratchet working, and the author who
// removed a hatch should not be blocked for not having also run --update. But
// unclaimed headroom is a hatch the NEXT branch can add for free, which is the
// slow leak that makes a ratchet stop ratcheting.
warnStale({ gate: GATE, stale, updateCommand: UPDATE_COMMAND, maxShown: MAX_SHOWN });

console.log("\ncheck-hatches: every file within its baseline. ✓");
