// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-file baseline ratchet, shared by the two gates that have one.
 *
 * `check-escape-hatches.mjs` and `guard-invariants.mjs` are the same machine
 * with different patterns: grep the tree per group, count per file, compare
 * against a committed `{ group: { file: count } }` baseline, refuse any file
 * that holds MORE than its budget, and let `--update` lower a number but never
 * raise one. That machine was written twice — `git()`, `parseMatch()`, the whole
 * merge/refuse block, the violations-and-stale reporting, ~110 lines — and the
 * copies had already drifted (only one of them documented why `git grep` exits
 * 1, only one deduplicated its output).
 *
 * ## The floor, and why it is on the CORPUS rather than on the count
 *
 * Both gates could report success while scanning NOTHING. `git grep` exits 1
 * for "no matches" AND for "pathspec matched nothing", and `allowNoMatch`
 * swallowed the two indiscriminately — so a package rename, or a `:!` exclusion
 * with a typo in it, made every group report `now=0`, degraded to the *stale*
 * warning path (which is deliberately not a failure), and printed a checkmark.
 * Four sibling gates already take a floor for exactly this
 * (`check-claude-md.mjs`'s "found no guide files", `api-report.mjs`,
 * `api-contracts.mjs`, `check-doc-examples.mjs`'s `MIN_EXAMPLES`).
 *
 * The floor here is on **how many files the pathspecs resolve to**, not on how
 * many matches came back, and that distinction is load-bearing: these are DEBT
 * ratchets whose goal is zero, so a minimum match count would eventually block
 * the very campaign the gate exists to encourage. A corpus floor is invariant
 * under debt reduction and catches precisely the failure above — every way the
 * scan can go blind shrinks the file set.
 *
 * The complementary half — a pattern that is alive but MATCHES NOTHING, the
 * `\b`-is-not-POSIX-ERE bug that left two patterns dead for months — is not
 * answerable from here at all, because a correct pattern over a clean tree looks
 * identical. That is what the positive/negative samples in
 * `packages/aai-templates/src/guard-invariants-gate.test.ts` and
 * `escape-hatch-scope.test.ts` are for. Between the two, a blind gate has
 * nowhere left to hide.
 *
 * One extra guard sits on top: an ALL-ZERO scan against a non-empty baseline is
 * a hard failure rather than a stale warning. Every group going to zero at once
 * is either the scan being blind in a way the corpus floor did not catch, or a
 * branch that removed every last occurrence — and the second is a one-command
 * fix whose message says so.
 */

import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compareNames, repoRoot } from "./_fs.mjs";

/**
 * Every git call is made FROM THE REPO ROOT, always.
 *
 * There were three `git()` helpers in these gates with three contracts, and only
 * one of them set this — under a comment explaining at length the bug the other
 * two still had. A pathspec is relative to the CWD, so `ls-files -- packages`
 * run from inside a package matches NOTHING and the rule prints `0 ✓`. That is
 * not hypothetical: it happened when the gate's own spec ran under
 * `pnpm --filter aai-templates test:coverage`, whose cwd is the package.
 */
const REPO_ROOT = repoRoot(import.meta.url);

/**
 * Run git from the repo root, returning stdout.
 *
 * `allowNoMatch` maps `git grep`'s exit 1 to an empty result. It cannot tell
 * "no matches" from "the pathspec matched nothing" — git uses the same status
 * for both — which is the entire reason `assertScanCorpus` below exists.
 *
 * @param {string[]} args
 * @param {{ allowNoMatch?: boolean, cwd?: string | URL }} [opts]
 */
export function git(args, { allowNoMatch = false, cwd = REPO_ROOT } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd });
  } catch (err) {
    if (allowNoMatch && err.status === 1) return "";
    throw err;
  }
}

/**
 * Split one `git grep -n` line into `{ file, line, text }`.
 *
 * Sliced positionally rather than split on ":" — a matched source line very
 * often contains colons.
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
 * Every work-tree OCCURRENCE of `re` under `pathspecs`.
 *
 * `--untracked` so a hit in a brand-new, not-yet-added file is counted —
 * otherwise `git add` is all it takes to defer a gate to a later commit.
 *
 * **`-o`, and that is the difference between an occurrence and a LINE.** Both
 * baseline files describe themselves as recording "how many occurrences each
 * file is allowed", and for as long as this ran without `-o` they recorded
 * matching lines: three `as unknown as` casts on one line reported `found 1`,
 * the same three on three lines reported `found 3`. Honest at the moment it was
 * measured (94 lines against 94 occurrences) and structurally wrong — any file
 * already at its budget could absorb more hatches by appending them to the line
 * that bought the budget, and rule 16 was affected identically.
 *
 * TWO passes, because `-o` prints the matched FRAGMENT and both callers need
 * the whole source line: the failure report prints it, and `isCommentOnly`
 * decides on it. The `-n` pass supplies the text, the `-o` pass the count.
 */
function grepMatches(re, pathspecs, { cwd } = {}) {
  const tail = ["--untracked", "-e", re, "--", ...pathspecs];
  const lineOut = git(["grep", "-nIE", ...tail], { allowNoMatch: true, cwd });
  if (lineOut === "") return [];
  /** Full source line, keyed `file:line` — restored onto every occurrence below. */
  const textAt = new Map();
  for (const raw of lineOut.split("\n")) {
    if (raw.length === 0) continue;
    const match = parseMatch(raw);
    textAt.set(`${match.file}:${match.line}`, match.text);
  }
  return git(["grep", "-nIoE", ...tail], { allowNoMatch: true, cwd })
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseMatch)
    .map((match) => ({ ...match, text: textAt.get(`${match.file}:${match.line}`) ?? match.text }));
}

/**
 * True when the line carries only prose — a `//` or `*` comment.
 *
 * Shared, because both gates need it and only one had it. `guard-invariants`
 * carries a per-rule `skipComments` flag and passes a filter in;
 * `check-escape-hatches` called `scanGroups` with no filter at all, so its
 * entire `as any` budget was two sentences of JSDoc — and a genuine
 * `(globalThis as any).x` could move into that budget with the gate still
 * printing `as any allowed=2 now=2 … every file within its baseline ✓`.
 * Demonstrated on the real gate before the flag was added.
 */
export function isCommentOnly(text) {
  return text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");
}

/**
 * Extensions whose files are legitimately invisible to `git grep`.
 *
 * A DENY-list of known-binary kinds rather than an allow-list of text kinds,
 * deliberately and for the reason the config schema is deny-listed: a new
 * source extension then defaults INTO being checked, where an allow-list would
 * silently exempt it. The whole diff under the gates' own pathspecs today is 8
 * files — 6 `.woff2` and 2 `.ico`.
 */
const KNOWN_BINARY = new Set([
  "avif",
  "bin",
  "eot",
  "gif",
  "gz",
  "ico",
  "jpeg",
  "jpg",
  "mp3",
  "mp4",
  "node",
  "ogg",
  "otf",
  // Raw PCM16 — an audio fixture with no container. `aai-ui`'s playback bench
  // records real TTS as `<name>.pcm` beside a `<name>.json` index, because a
  // WAV header would be four bytes of ceremony over the same samples and the
  // trace has its own metadata file already.
  "pcm",
  "pdf",
  "png",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "zip",
]);

/**
 * Files in the corpus that `git grep` treats as BINARY and therefore skips.
 *
 * **The corpus floor cannot catch this, by design** — the file is present in
 * `git ls-files` and invisible only to `grep`, so both numbers look right and
 * nothing compared the two lists. It has now cost this repo three times: a
 * single raw NUL byte in `host/workflow-notify.ts`, then in
 * `host/workflow-keys.ts`, each silently exempting a shipped module from every
 * line rule and every escape-hatch pattern. The first two times the response
 * was to fix the byte and add no detector. This is the detector.
 *
 * A zero-byte file has no line for `git grep -lI -e ''` to list either; it is
 * not binary, and is spared on SIZE rather than on extension.
 */
function binaryInCorpus(files, pathspecs, cwd) {
  const textual = new Set(
    git(["grep", "-lI", "--untracked", "-e", "", "--", ...pathspecs], { allowNoMatch: true, cwd })
      .split("\n")
      .filter(Boolean),
  );
  const root = cwd === undefined ? REPO_ROOT : String(cwd);
  return files.filter((file) => {
    if (textual.has(file)) return false;
    if (KNOWN_BINARY.has(file.split(".").pop()?.toLowerCase() ?? "")) return false;
    try {
      return statSync(join(root, file)).size > 0;
    } catch {
      return false;
    }
  });
}

/**
 * Fail unless `pathspecs` resolves to at least `minFiles` files, and unless
 * every one of those files is VISIBLE to `git grep`.
 *
 * The floor is a real number with headroom rather than `> 0`, because the
 * interesting failure is PARTIAL: an exclusion that swallows one package still
 * leaves the scan walking something, and "walking something" is not the claim
 * the checkmark makes.
 *
 * @param {{ gate: string, what: string, pathspecs: string[], minFiles: number, cwd?: string|URL }} opts
 * @returns {number} the number of files in scope
 */
export function assertScanCorpus({ gate, what, pathspecs, minFiles, cwd }) {
  const files = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], {
        allowNoMatch: true,
        cwd,
      })
        .split("\n")
        .filter(Boolean),
    ),
  ];
  const unique = files.length;
  const opaque = unique === 0 ? [] : binaryInCorpus(files, pathspecs, cwd);
  if (opaque.length > 0) {
    console.error(
      `\n${gate}: ${opaque.length} file(s) in ${what} are BINARY to \`git grep\`, ` +
        "so every pattern skips them silently:\n",
    );
    for (const file of opaque) console.error(`  ${file}`);
    console.error(
      "\nAlmost always ONE control character in an otherwise ordinary source file.\n" +
        "A single raw NUL is enough, and it exempts the whole file from every\n" +
        "guard-invariants line rule and every check-escape-hatches pattern while\n" +
        "the corpus floor still counts it — which is why this is checked here and\n" +
        "not by the floor. Spell the character as an ESCAPE: byte-identical\n" +
        "behaviour, and the file goes back to being text. Find it with\n" +
        "`cat -v <file> | grep -n '\\^@'`. If the file is genuinely binary, add its\n" +
        "extension to KNOWN_BINARY in scripts/_ratchet.mjs.\n",
    );
    process.exit(1);
  }
  if (unique < minFiles) {
    console.error(
      `\n${gate}: ${what} resolves to ${unique} file(s), below the floor of ${minFiles}.\n\n` +
        "The scan is walking less of the tree than it is supposed to, and a\n" +
        "ratchet over an empty corpus reports every pattern at 0 and prints a\n" +
        "checkmark. Check the pathspecs for a renamed directory or a `:!`\n" +
        "exclusion that matches more than it reads like it does — a git pathspec\n" +
        "is fnmatch WITHOUT FNM_PATHNAME, so `a/**/*.md` requires a subdirectory\n" +
        "and does NOT match `a/README.md`. Verify one with `git ls-files <glob>`,\n" +
        "never by reading it.\n",
    );
    process.exit(1);
  }
  return unique;
}

/**
 * Scan every group, returning per-file counts and the matching lines.
 *
 * A group is `{ key, re, paths }` plus whatever else the caller carries.
 * `filter` drops matches the caller does not want counted (self-referential
 * files, comment-only lines).
 *
 * @param {{ key: string, re: string, paths: string[] }[]} groups
 * @param {{ filter?: (match: object, group: object) => boolean, cwd?: string|URL }} [opts]
 */
export function scanGroups(groups, { filter, cwd } = {}) {
  /** @type {Map<string, Map<string, number>>} */
  const counts = new Map();
  /** @type {Map<string, Map<string, object[]>>} */
  const occurrences = new Map();
  let total = 0;
  for (const group of groups) {
    const byFile = new Map();
    const linesByFile = new Map();
    for (const match of grepMatches(group.re, group.paths, { cwd })) {
      if (filter !== undefined && !filter(match, group)) continue;
      byFile.set(match.file, (byFile.get(match.file) ?? 0) + 1);
      linesByFile.set(match.file, [...(linesByFile.get(match.file) ?? []), match]);
      total += 1;
    }
    counts.set(group.key, byFile);
    occurrences.set(group.key, linesByFile);
  }
  return { counts, occurrences, total };
}

/** Sum of a `{ file: count }` record. */
export const totalOf = (record) => Object.values(record ?? {}).reduce((sum, n) => sum + n, 0);

/**
 * `--update`: lower every baseline entry to the tree, and REFUSE to raise one.
 *
 * That asymmetry is the whole contract. `--update` is a convenience for
 * recording removals, not a way to bless additions — otherwise the gate would be
 * advisory, since every failure would have a one-command bypass and the
 * reviewable diff (the actual control on a deliberate increase) would never be
 * produced.
 *
 * @param {{
 *   gate: string,
 *   baselinePath: string | URL,
 *   baseline: Record<string, unknown>,
 *   groups: { key: string, label: string }[],
 *   counts: Map<string, Map<string, number>>,
 *   advice: string,
 *   describe?: (next: Record<string, unknown>) => string,
 * }} opts
 */
/**
 * Merge one group's budgets against the tree, recording every move.
 *
 * A file over its budget keeps the OLD number in the merged result: `--update`
 * writes a baseline that is still honest about what was allowed, and the refusal
 * below is what stops the run.
 */
function mergeGroup(allowed, current, label, { lowered, refused }) {
  const merged = {};
  for (const file of new Set([...Object.keys(allowed), ...current.keys()])) {
    const was = allowed[file] ?? 0;
    const now = current.get(file) ?? 0;
    if (now > was) {
      refused.push({ label, file, was, now });
      if (was > 0) merged[file] = was;
      continue;
    }
    if (now < was) lowered.push({ label, file, was, now });
    if (now > 0) merged[file] = now;
  }
  return merged;
}

export function updateBaseline({ gate, baselinePath, baseline, groups, counts, advice, describe }) {
  const next = {};
  const moves = { lowered: [], refused: [] };

  for (const { key, label } of groups) {
    const merged = mergeGroup(baseline[key] ?? {}, counts.get(key) ?? new Map(), label, moves);
    if (Object.keys(merged).length > 0) {
      next[key] = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => compareNames(a, b)));
    }
  }

  // `describe` is handed the MERGED result, not the old baseline: a description
  // that says which rules have no entry has to read the file being written, or
  // it goes stale the first time a rule's last occurrence is removed — which is
  // the class of staleness generating it was meant to end.
  const described = { _description: describe?.(next) ?? baseline._description, ...next };

  const { lowered, refused } = moves;
  if (refused.length > 0) {
    console.error(`\n${gate} --update: refusing to RAISE ${refused.length} entr(ies):\n`);
    for (const { label, file, was, now } of refused) {
      console.error(`  ${label}  ${file}  ${was} -> ${now}`);
    }
    console.error(`\n${advice}\n`);
    process.exit(1);
  }

  writeFileSync(baselinePath, `${JSON.stringify(described, null, 2)}\n`);
  if (lowered.length === 0) {
    console.log(`${gate} --update: baseline already matches the work tree.`);
  } else {
    console.log(`${gate} --update: lowered ${lowered.length} entr(ies):\n`);
    for (const { label, file, was, now } of lowered) {
      console.log(`  ${label}  ${file}  ${was} -> ${now}`);
    }
  }
  process.exit(0);
}

/**
 * Files over budget, and baseline entries the tree now sits under.
 *
 * @param {{ key: string, label: string }[]} groups
 * @param {Record<string, unknown>} baseline
 * @param {Map<string, Map<string, number>>} counts
 */
export function compareToBaseline(groups, baseline, counts) {
  const violations = [];
  const stale = [];
  let allowedTotal = 0;
  let currentTotal = 0;
  for (const { key, label } of groups) {
    const allowed = baseline[key] ?? {};
    const current = counts.get(key) ?? new Map();
    for (const [file, count] of current) {
      const budget = allowed[file] ?? 0;
      if (count > budget) violations.push({ key, label, file, budget, count });
    }
    for (const [file, budget] of Object.entries(allowed)) {
      const count = current.get(file) ?? 0;
      if (count < budget) stale.push({ key, label, file, budget, count });
    }
    allowedTotal += totalOf(allowed);
    currentTotal += [...current.values()].reduce((sum, n) => sum + n, 0);
  }
  return { violations, stale, allowedTotal, currentTotal };
}

/**
 * Fail when EVERY group came back empty against a non-empty baseline.
 *
 * The corpus floor covers a scan that walks nothing; this covers the residue —
 * a scan that walks the right files and still reports universal zero, which is
 * either a blindness the floor did not catch or a branch that removed the last
 * occurrence of everything at once. Both want a human, and the message names
 * both.
 */
export function assertNotUniversallyEmpty({ gate, allowedTotal, currentTotal, updateCommand }) {
  if (currentTotal > 0 || allowedTotal === 0) return;
  console.error(
    `\n${gate}: every pattern reported 0 against a baseline of ${allowedTotal}.\n\n` +
      "That is either a scan that has gone blind — the shape this gate exists to\n" +
      "prevent, since a blind ratchet prints the same checkmark as a clean tree —\n" +
      "or a branch that genuinely removed the last occurrence of every pattern.\n" +
      `If it is the second, record it: \`${updateCommand}\`.\n`,
  );
  process.exit(1);
}

/** Print the stale-headroom warning. Not a failure — see the callers' notes. */
export function warnStale({ gate, stale, updateCommand, maxShown = 20 }) {
  if (stale.length === 0) return;
  console.warn(
    `\n${gate}: ${stale.length} baseline entr(ies) now sit above the real count — ` +
      `run \`${updateCommand}\` to give the headroom back:\n`,
  );
  for (const { label, file, budget, count } of stale.slice(0, maxShown)) {
    console.warn(`  ${label}  ${file}  ${budget} -> ${count}`);
  }
  if (stale.length > maxShown) console.warn(`  … and ${stale.length - maxShown} more`);
}
