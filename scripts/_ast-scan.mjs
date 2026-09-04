// Copyright 2026 the AAI authors. MIT license.
/**
 * A REAL PARSE for the gates that police JavaScript and TypeScript.
 *
 * `git grep -E` is what every `guard-invariants` line rule runs on, and it is
 * the right engine for most of them: a rule about a NAME (`delete process.env`)
 * or about a string that appears in the source is a substring question, and
 * grep answers it over 1,500 files in a few hundred milliseconds. This module
 * exists for the rules that are NOT substring questions — the ones whose
 * subject is a piece of SYNTAX, where the pattern has to reason about which
 * argument a value sits in, whether a callback is `async`, or whether a delay
 * is zero.
 *
 * ## Why those rules kept being wrong
 *
 * The timing family (`guard-invariants-rules-timing.mjs`) is the worked case,
 * and its own module doc said so before this module existed: "all of them are
 * substring guards over a language with syntax, and every gap found in this
 * gate has been in one of them." The history is on the record:
 *
 *   - rule 4's first draft used a negated-paren class between `new Promise(`
 *     and `setTimeout(`, which cannot cross the arrow's own parameter list, so
 *     it reported 0 against five real occurrences;
 *   - the fix required a literal open paren after `new Promise`, so a type
 *     argument evaded rules 4 AND 19 — five different live occurrences;
 *   - rule 3 was line-anchored, so the multi-line `Promise.race([` Biome emits
 *     was invisible, and the widening that fixed it can no longer tell whether
 *     a timer is among the elements, so it deliberately OVER-reports;
 *   - rule 21's pattern could not see `await expect` + a newline + `.poll(`,
 *     which is what Biome emits the moment the call does not fit on one line.
 *     Two live occurrences, in two scenario suites, while the gate printed
 *     `allowed=0 now=0` and a checkmark;
 *   - rule 4 could not see the same promise written with a BLOCK body either.
 *     `aai-ui/_react-test-utils.ts` writes its `tick()` that way and says so in
 *     a doc comment: "the one occurrence in this package was in no baseline and
 *     reported by nothing."
 *
 * Every one of those is the same failure, and it is the one this repo cares
 * most about: a gate whose success output is indistinguishable from a gate that
 * checked nothing. They are not bugs in the individual patterns. A line-based
 * matcher cannot see a construct that spans lines, and Biome decides where the
 * lines go — so the set of shapes a pattern can see is a function of how long
 * the surrounding identifiers happen to be.
 *
 * ## What the parse costs
 *
 * `oxc-parser` is a Rust parser with no config and no build step, already a
 * root devDependency for `check-test-assertions.mjs`. Measured on this tree:
 * 2,095 files, 18.6 MB of source, 1.6 s to parse all of them, zero parse
 * errors. That is the whole repo; the timing rules' own corpus is smaller. The
 * gate goes from ~1.2 s to ~2.5 s, which buys the removal of ~140 lines of
 * hand-tuned POSIX ERE and the entire class of miss above.
 *
 * ## What a node rule does NOT need
 *
 * Three pieces of machinery every line rule carries stop existing here, and
 * each of them was a workaround for the missing parse:
 *
 *   - **`skipComments`.** A comment is not a node. `_ratchet.mjs`'s
 *     `isCommentOnly` is a heuristic over a line's first characters; the parser
 *     simply never yields the text.
 *   - **String masking.** A rule's own remedy text quoting the anti-pattern is
 *     a string literal, not a call — which is why the rules module no longer
 *     needs a `SELF_REFERENTIAL` entry for the node rules it defines.
 *   - **Word-boundary avoidance.** `\b` is a GNU extension git's matcher does
 *     not implement, which silently dead-ended two `check-escape-hatches.mjs`
 *     patterns for months. An `Identifier` node has a `name`, and comparing it
 *     is exact.
 *
 * A file that will not PARSE is reported and fails the run, for the reason
 * `_test-assertions-parse.mjs` gives: skipping it silently is the same shape as
 * the bug the gate exists to catch.
 */

import { readFileSync } from "node:fs";

import { parseSync } from "oxc-parser";

import { git } from "./_ratchet.mjs";

/**
 * Extensions oxc parses, and the reason the corpus needs its own floor.
 *
 * `SOURCE_PATHSPECS` resolves to ~1,530 files, of which the JSON, the YAML and
 * the snapshots are not source. Filtering them out is correct and is ALSO a
 * brand-new way for a scan to walk nothing: a renamed extension, or this set
 * losing an entry, empties the corpus while every pathspec still resolves. So
 * {@link scanNodeGroups} floors what is left, the same way `assertScanCorpus`
 * floors what the pathspecs resolve to.
 */
const PARSEABLE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const extensionOf = (file) => {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot);
};

/**
 * Visit every node under `node`. A visitor returning `false` keeps the walk out
 * of that node's children.
 *
 * There is deliberately NO parent pointer or node stack. A draft carried one on
 * the guess that a rule would need to ask where a node sits, and not one of the
 * six does — rule 23 asks which ARGUMENT a listener is, which is a question
 * about the call it already matched, and rule 3 walks its own arguments. A
 * threaded stack is state every visit has to maintain for a caller that does
 * not exist; the shape of a rule that needed one would say what it should hold.
 */
export function walk(node, visit) {
  // A guard that must ADMIT arrays: an AST node's children are arrays, so
  // narrowing them away would stop the walk at the first `body` or `arguments`.
  // (Baselined against rule 17 for the reason `_test-assertions-parse.mjs` is —
  // a `scripts/*.mjs` gate cannot import the SDK's `isRecord`.)
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string" && visit(node) === false) return;
  for (const key in node) if (key !== "type") walk(node[key], visit);
}

/** Offsets of every line start, so a position costs a binary search. */
function lineStarts(source) {
  const starts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/**
 * A source file's line index: 1-based line numbers, and the TEXT of a line.
 *
 * The text is what the gate prints and what GitHub annotates, so it has to be
 * the line a reader can go and look at — the first line of the construct rather
 * than the whole multi-line node flattened onto one.
 */
export function lineIndexOf(source) {
  const starts = lineStarts(source);
  const lineAt = (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  return {
    lineAt,
    textAt(offset) {
      const start = starts[lineAt(offset) - 1];
      const end = source.indexOf("\n", start);
      return source.slice(start, end === -1 ? source.length : end).trim();
    },
  };
}

/**
 * Parse one source, or throw with the file named.
 *
 * @param {string} file - Used only to pick the dialect (`.ts` vs `.tsx`).
 * @param {string} source
 */
export function parseSource(file, source) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`${file}: ${first.message ?? String(first)}`);
  }
  return parsed.program;
}

/**
 * Run one node rule over one source and return every hit.
 *
 * Exported so a gate's SPEC can exercise a rule against a snippet without
 * touching the repo. That is the whole reason a node rule's samples are real
 * SOURCE rather than a line contrived to satisfy a regex: the sample proving a
 * rule sees the multi-line shape is now written in the multi-line shape.
 *
 * @param {{ match: (node: object) => boolean }} rule
 * @param {string} file
 * @param {string} source
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function matchesIn(rule, file, source) {
  const program = parseSource(file, source);
  const index = lineIndexOf(source);
  const found = [];
  walk(program, (node) => {
    if (rule.match(node) !== true) return;
    found.push(locate(rule, node, file, index));
  });
  return found;
}

/**
 * Where to REPORT a match: the matched node, or whatever the rule's `at` names.
 *
 * A rule matches the construct it is about and reports where a reader can act.
 * Those are usually the same node and sometimes are not — rule 21 matches the
 * whole `expect.poll(...)` call, whose start is on an `await expect` line when
 * Biome has wrapped it.
 */
function locate(rule, node, file, index) {
  const anchor = (rule.at === undefined ? node : rule.at(node)) ?? node;
  return { file, line: index.lineAt(anchor.start), text: index.textAt(anchor.start) };
}

/** Files `pathspecs` resolves to, filtered to the ones a parser can read. */
function parseableFiles(pathspecs) {
  return [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], {
        allowNoMatch: true,
      })
        .split("\n")
        .filter(Boolean),
    ),
  ].filter((file) => PARSEABLE.has(extensionOf(file)));
}

/**
 * The node-rule twin of `_ratchet.mjs`'s `scanGroups`, returning the SAME
 * `{ counts, occurrences, total }` shape.
 *
 * Sameness is the point: the baseline file, `--update`, the per-file budgets
 * and the failure report in `guard-invariants.mjs` are all written against that
 * shape, and none of them should care whether a rule was answered by grep or by
 * a parse. A rule migrating from one engine to the other keeps its id, its
 * baseline key and its recorded budgets.
 *
 * Every file parses ONCE however many groups scan it, which is what keeps the
 * marginal cost of a seventh node rule at zero.
 *
 * @param {{ key: string, paths: string[], match: Function }[]} groups
 * @param {{ filter?: (match: object, group: object) => boolean, minFiles?: number }} [opts]
 */
export function scanNodeGroups(groups, { filter, minFiles = 0 } = {}) {
  /** @type {Map<string, Set<string>>} Distinct corpora, keyed by their pathspecs. */
  const corpora = new Map();
  for (const group of groups) {
    const key = group.paths.join(" ");
    if (!corpora.has(key)) corpora.set(key, new Set(parseableFiles(group.paths)));
  }

  const scanned = new Set([...corpora.values()].flatMap((files) => [...files]));
  if (scanned.size < minFiles) {
    console.error(
      `\nguard-invariants: the node-rule scan resolves to ${scanned.size} parseable ` +
        `file(s), below the floor of ${minFiles}.\n\n` +
        "A rule over an empty corpus reports 0 and prints a checkmark. Check\n" +
        "PARSEABLE in scripts/_ast-scan.mjs for a missing extension, and the\n" +
        "rules' pathspecs for a renamed directory.\n",
    );
    process.exit(1);
  }

  const counts = new Map();
  const occurrences = new Map();
  for (const group of groups) {
    counts.set(group.key, new Map());
    occurrences.set(group.key, new Map());
  }

  const failures = [];
  let total = 0;
  for (const file of scanned) {
    const active = groups.filter((group) => corpora.get(group.paths.join(" "))?.has(file));
    if (active.length === 0) continue;
    const source = readFileSync(file, "utf8");
    let program;
    try {
      program = parseSource(file, source);
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    const index = lineIndexOf(source);
    walk(program, (node) => {
      for (const group of active) {
        if (group.match(node) !== true) continue;
        const match = locate(group, node, file, index);
        if (filter !== undefined && !filter(match, group)) continue;
        const byFile = counts.get(group.key);
        byFile.set(file, (byFile.get(file) ?? 0) + 1);
        const lines = occurrences.get(group.key);
        lines.set(file, [...(lines.get(file) ?? []), match]);
        total += 1;
      }
    });
  }

  if (failures.length > 0) {
    console.error(
      `\nguard-invariants: ${failures.length} file(s) in the node-rule corpus did not parse:\n`,
    );
    for (const message of failures) console.error(`  ${message}`);
    console.error(
      "\nSkipping them would leave every node rule silently blind to whatever\n" +
        "they hold, which is the failure this gate exists to catch. Fix the\n" +
        "syntax, or narrow the rule's pathspecs if the file is not source.\n",
    );
    process.exit(1);
  }

  return { counts, occurrences, total, files: scanned.size };
}
