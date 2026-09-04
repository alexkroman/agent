#!/usr/bin/env node

/**
 * Mechanical enforcement of repo invariants.
 *
 * Most of AGENTS.md is a rule with a story attached — "use `p-timeout`, never a
 * hand-rolled `Promise.race`", "reach for `vi.stubEnv(name, undefined)` rather
 * than `delete process.env.X`" — and each story is there because the rule was
 * learned by getting it wrong. But prose is only enforcement while somebody
 * remembers it at review time, and the guide is ~106k characters. Every rule here
 * is one that used to live only in that file.
 *
 * Each guard prints WHY the invariant exists and what to do instead, so a
 * violation is self-correcting and a reviewer never has to re-explain it. The
 * numeric IDs are stable identifiers: a rule that is deleted leaves its number
 * retired rather than letting a later rule inherit it, because the numbers show
 * up in commit messages and in `guard-invariants-baseline.json`. Rules 6 and 10
 * are retired and 15 is reserved; nothing may reuse them.
 *
 * ## The catalogue is DERIVED — `node scripts/guard-invariants.mjs --rules`
 *
 * This header used to carry the rule list in prose, and it went stale exactly
 * the way a hand-kept list of anything does here: rules 17, 18 and 19 were
 * absent, and a missing newline had run two rules' paragraphs together. The
 * one line that did NOT drift was the printed count, because it is computed from
 * the rule counts. So the catalogue is computed the
 * same way now, from the `id`/`label`/`remedy` every rule already carries, and
 * `--rules` prints it. A new rule joins the catalogue by existing.
 *
 * The baseline's `_description` is generated from the same data by `--update`,
 * for the same reason: the hand-written one named three of the six rules that
 * are enforced at zero.
 *
 * Baselines for rules with pre-existing violations live in
 * `guard-invariants-baseline.json`. Counts there may only SHRINK. `--update`
 * lowers them for you and refuses to raise any, so recording a removal is one
 * command and blessing an addition needs a hand edit that shows up in review —
 * the same contract as `check-escape-hatches.mjs`, whose machinery this shares
 * (`_ratchet.mjs`, which also carries the corpus floor both gates were missing).
 *
 * Wired up as `pnpm check:invariants`, in `scripts/check.mjs` and the CI check
 * job (both — see AGENTS.md on ratchets that lived in only one).
 */

import { readFileSync } from "node:fs";

import { parseScriptArgs } from "./_args.mjs";
import { scanNodeGroups } from "./_ast-scan.mjs";
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
import { scanChangesetPackageNames } from "./guard-invariants-changesets.mjs";
import { SELF_REFERENTIAL_ENTRIES } from "./guard-invariants-exemptions.mjs";
import { LINE_RULES, NODE_RULES, SCAN_CORPORA } from "./guard-invariants-rules.mjs";
import {
  scanSymlinks,
  scanTemplateEscapingImports,
  scanUndeclaredGuestRoutes,
  scanUnpinnedActions,
  scanUnreadFixtureDirs,
} from "./guard-invariants-scanners.mjs";

const BASELINE_PATH = new URL("guard-invariants-baseline.json", import.meta.url);

const SELF_REFERENTIAL = new Map(SELF_REFERENTIAL_ENTRIES);

/** Is `file` exempt from the rule keyed `ruleKey`? */
function isSelfReferential(file, ruleKey) {
  const scope = SELF_REFERENTIAL.get(file);
  if (scope === undefined) return false;
  return scope === "*" || scope.includes(ruleKey);
}

/** Drop the matches a rule must not count: its own definition, and prose. */
function countsAsViolation(match, rule) {
  if (isSelfReferential(match.file, rule.key)) return false;
  return !(rule.skipComments && isCommentOnly(match.text));
}

// ---------------------------------------------------------------------------
// Run every rule
// ---------------------------------------------------------------------------

/**
 * Rules with no baseline: enforced absolutely, because the tree holds zero
 * violations today and the whole point is that it stays that way. Listing them
 * separately from the baselined rules keeps "this is at zero" visible instead
 * of implied by an empty JSON object.
 */
const ABSOLUTE_RULES = [
  {
    id: 1,
    label: "symlink",
    scan: scanSymlinks,
    remedy:
      "Replace it with a real file, or a module that re-exports. Symlinks do\n" +
      "not survive an npm tarball, `aai init`'s scaffold copy, and the Modal\n" +
      "guest image identically — a link that resolves in a checkout can arrive\n" +
      "dangling or as a 12-byte text file.",
  },
  {
    id: 7,
    label: "unpinned GitHub Action",
    scan: scanUnpinnedActions,
    remedy:
      "Pin to a 40-character commit SHA with the release in a trailing comment:\n" +
      "  uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n" +
      "A tag is a mutable pointer, so `@v7` grants every future version of that\n" +
      "code the permissions of the job it runs in — including the release job's\n" +
      "npm token. Nothing refreshes these pins automatically since Dependabot\n" +
      "was removed, so bump the SHA and its comment together by hand.",
  },
  {
    id: 12,
    label: "undeclared guest route",
    scan: scanUndeclaredGuestRoutes,
    remedy:
      "Add the path to `GUEST_ROUTES` in packages/aai-server/src/guest-routes.ts and\n" +
      "give it an exposure in `GUEST_ROUTE_EXPOSURE` (the `satisfies` makes the\n" +
      "second half a compile error once the first is done).\n\n" +
      "The exposure is decided by WHO CALLS IT: `direct-dial` when a browser or a\n" +
      "carrier dials the sandbox having been handed the URL, `proxied` when the\n" +
      "platform must serve `/:slug<path>` and forward it, `host-only` when only\n" +
      "the platform dials it holding a token, `guest-internal` when nothing\n" +
      "outside the container calls it at all.\n\n" +
      "A literal ending in `/` is a prefix gate and passes only while a declared\n" +
      "route lives under it — a prefix dispatch is how the guest's real surface\n" +
      "gets wider than the table without any one literal being new.",
  },
  {
    id: 14,
    label: "fixture directory nothing reads",
    scan: scanUnreadFixtureDirs,
    remedy:
      "Delete it, or add the test that reads it.\n\n" +
      "`packages/aai-server/` held a pinned RPC fixture set — with a README\n" +
      'instructing the reader to "never delete" a committed fixture — for five\n' +
      "commits after its only reader (`sandbox-compat.test.ts`) was deleted in\n" +
      "30914c9b. Nothing noticed, and the `turbo.json` comment justifying that\n" +
      "task's cache inputs cited it BY NAME as a reason tests need to hash JSON,\n" +
      "so the repo was hashing a fixture set no test read.\n\n" +
      "A reference has to RESOLVE, not just match the name: the surviving\n" +
      "`aai/sdk/compat-fixtures/` is reached as\n" +
      "`join(import.meta.dirname, …)` from its own sibling, and that string is why\n" +
      "a name-only scan called the dead directory read. A cross-package reader\n" +
      "counts — aai-cli's e2e suite reads aai-ui's fixtures.",
  },
  {
    id: 20,
    label: "changeset release metadata is inert",
    scan: scanChangesetPackageNames,
    remedy:
      "Use the package's real name from its package.json, and one of\n" +
      "`patch` / `minor` / `major`.\n\n" +
      "It also covers a bump that SHIPS nowhere: aai-studio-client, aai-guest\n" +
      "and aai-templates are each built into another package's artifact, so\n" +
      "naming one alone passes every gate and delivers nothing (`SHIPS_VIA`).\n\n" +
      "A changeset whose key is a typo is IGNORED rather than rejected:\n" +
      "`pnpm changeset status --since=origin/main` — the pre-push hook's own\n" +
      "check — prints an empty bump list and exits 0. The release then silently\n" +
      "does not happen, and it is found after merge on a branch that is gone.\n\n" +
      "The fixed group is what makes this easy to mistype: a changeset lists one\n" +
      "of `@alexkroman1/aai`, `/aai-ui`, `/aai-cli` and the other two follow, so\n" +
      "the name gets typed from memory. `pnpm changeset:create` does not check it.\n\n" +
      "The rule also covers a changeset naming only packages `changeset version`\n" +
      "will not bump (private, with `privatePackages.version` off, or `ignore`d).\n" +
      "That one cannot be consumed at all: version changes nothing, the release\n" +
      'action force-pushes an empty branch and dies on "No commits between", and\n' +
      "since it only publishes when NO changesets are pending, nothing is ever\n" +
      "released again. The guest image installs the SDK from npm at the version\n" +
      "this repo declares, so that took production down — every sandbox spawn\n" +
      "failed on a version that was never published.\n\n" +
      "An EMPTY frontmatter block is fine — `pnpm changeset add --empty` is the\n" +
      "documented way to say a change needs no release.",
  },
  {
    id: 13,
    label: "template import escaping its template",
    scan: scanTemplateEscapingImports,
    remedy:
      "A template SHIPS. `aai init` copies `templates/<name>/` into a user's\n" +
      "project and nothing above it comes along, so this import resolves here\n" +
      "and in nothing a user runs.\n\n" +
      "Move what you need INTO the template, or publish it on the SDK and import\n" +
      "it by package name. A shared spec helper belongs on\n" +
      "`@alexkroman1/aai/testing` — that is where `withDiscoveredTools` went\n" +
      "when five templates were reaching up to `../../_tool-discovery.ts`.\n\n" +
      "This rule exists because every other gate runs IN THIS REPO, where the\n" +
      "relative path resolves: those five broke `aai test`, `aai build` and\n" +
      "`npm start` for their own users while `check:template-types`,\n" +
      "`templates.test.ts` and each template's own spec stayed green.",
  },
];

/**
 * Every rule with a per-file budget, whichever ENGINE answers it.
 *
 * A line rule is scanned by `git grep -E` and a node rule by a parse
 * (`scripts/_ast-scan.mjs`), and past that one difference nothing downstream
 * distinguishes them: they share `guard-invariants-baseline.json`, the
 * `--update` refuse-to-raise contract, the per-file comparison and the failure
 * report. Interleaving them BY ID rather than concatenating is what keeps the
 * summary in rule-number order and the generated baseline's key order a
 * function of the rule set — the same property the four rule modules already
 * relied on, now across the two kinds as well, so migrating a rule from one to
 * the other does not rewrite the baseline.
 */
const BASELINED_RULES = [...LINE_RULES, ...NODE_RULES].sort((a, b) => a.id - b.id);

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { rules: { type: "boolean" }, update: { type: "boolean" } },
});

const GATE = "guard-invariants";
const UPDATE_COMMAND = "node scripts/guard-invariants.mjs --update";

/**
 * The rule catalogue, DERIVED. `node scripts/guard-invariants.mjs --rules`.
 *
 * The prose version of this lived in the header and went three rules stale
 * (17, 18 and 19 were absent) while the one computed line — the count at the
 * bottom of a run — stayed right. So the catalogue is computed too, and a new
 * rule joins it by existing.
 */
function ruleCatalogue() {
  const rows = [
    ...ABSOLUTE_RULES.map((r) => ({ ...r, enforcement: "absolute (no baseline)" })),
    ...BASELINED_RULES.map((r) => ({ ...r, enforcement: `per-file baseline (${r.key})` })),
  ].sort((a, b) => a.id - b.id);
  const lines = [`${GATE}: ${rows.length} rule(s).\n`];
  for (const { id, label, remedy, enforcement } of rows) {
    lines.push(`rule ${String(id).padStart(2)} — ${label}  [${enforcement}]`);
    for (const line of remedy.split("\n")) lines.push(`    ${line}`);
    lines.push("");
  }
  lines.push("Rules 6 and 10 (retired) and 15 (reserved) have no definition; the numbers");
  lines.push("stay retired rather than being reused — they appear in commit messages");
  lines.push("and in the baseline's history.");
  return lines.join("\n");
}

if (FLAGS.rules === true) {
  console.log(ruleCatalogue());
  process.exit(0);
}

/**
 * The baseline's `_description`, generated rather than carried forward.
 *
 * The hand-written one named three of the six rules that are enforced at zero,
 * which is the same staleness the prose catalogue had. Derived — and derived
 * from the baseline being WRITTEN rather than the one that was read, so
 * "enforced at zero, no entry here" cannot go stale the first time a rule's last
 * occurrence is removed.
 */
function baselineDescription(next) {
  const zeroed = [
    ...ABSOLUTE_RULES.map((r) => r.id),
    ...BASELINED_RULES.filter((r) => next[r.key] === undefined).map((r) => r.id),
  ].sort((a, b) => a - b);
  return (
    "Per-file budgets for guard-invariants' baselined rules — see scripts/guard-invariants.mjs " +
    "and `node scripts/guard-invariants.mjs --rules`. A file may hold FEWER than its " +
    "number and may never hold more; `--update` lowers an entry and refuses to raise one. " +
    "Generated: do not hand-edit except to bless a deliberate increase. Enforced at zero, " +
    `with no entry here: rule ${zeroed.join(", rule ")}.`
  );
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

for (const corpus of SCAN_CORPORA) assertScanCorpus({ gate: GATE, ...corpus });

/**
 * Per-baselined-rule `{ file: count }` in the current tree, plus the lines.
 *
 * Two scans, one result. `scanNodeGroups` returns the same
 * `{ counts, occurrences }` shape `scanGroups` does, so merging them is a map
 * union and every consumer below is written against one set of rules rather
 * than against an engine.
 *
 * `NODE_RULE_FILE_FLOOR` is the node scan's own corpus floor, and it is not
 * redundant with `SCAN_CORPORA` above: those floor what the PATHSPECS resolve
 * to, and this floors what survives the parseable-extension filter — a brand
 * new way for a scan to walk nothing while every pathspec still resolves.
 * Measured at 1,410 of the 1,530 files `SOURCE_PATHSPECS` names.
 */
const NODE_RULE_FILE_FLOOR = 800;
const lineScan = scanGroups(LINE_RULES, { filter: countsAsViolation });
const nodeScan = scanNodeGroups(NODE_RULES, {
  filter: countsAsViolation,
  minFiles: NODE_RULE_FILE_FLOOR,
});
const actual = new Map([...lineScan.counts, ...nodeScan.counts]);
const occurrences = new Map([...lineScan.occurrences, ...nodeScan.occurrences]);

// ---------------------------------------------------------------------------
// --update
// ---------------------------------------------------------------------------

if (FLAGS.update === true) {
  updateBaseline({
    gate: GATE,
    baselinePath: BASELINE_PATH,
    baseline,
    groups: BASELINED_RULES.map((rule) => ({ ...rule, label: `rule ${rule.id}` })),
    counts: actual,
    describe: baselineDescription,
    advice:
      "Baselines only ratchet down. Fix the violation. If an occurrence is\n" +
      "genuinely unavoidable, raise the number by hand and say why in the PR —\n" +
      "the increase then lands in a reviewable diff.",
  });
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const MAX_SHOWN = 20;
const MAX_TEXT = 100;
/** GitHub renders these inline on the PR diff. */
const ANNOTATE = process.env.GITHUB_ACTIONS === "true";

let failed = false;

function annotate(file, line, message) {
  if (!ANNOTATE) return;
  const at = line > 0 ? `,line=${line}` : "";
  console.log(`::error file=${file}${at}::${message.replace(/\n/g, " ")}`);
}

for (const { id, label, scan, remedy } of ABSOLUTE_RULES) {
  const found = scan();
  if (found.length === 0) {
    console.log(`  rule ${String(id).padStart(2)}  ${label.padEnd(34)}  0 ✓`);
    continue;
  }
  failed = true;
  console.error(`\nguard-invariants: rule ${id} — ${found.length} ${label} violation(s):\n`);
  for (const { file, line, text } of found.slice(0, MAX_SHOWN)) {
    const where = line > 0 ? `${file}:${line}` : file;
    const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
    console.error(`  ${where}  ${shown}`);
    annotate(file, line, `rule ${id}: ${label} — ${text}`);
  }
  if (found.length > MAX_SHOWN) console.error(`  … and ${found.length - MAX_SHOWN} more`);
  console.error(`\n${remedy}\n`);
}

const {
  stale,
  allowedTotal: baselineTotal,
  currentTotal: treeTotal,
} = compareToBaseline(
  BASELINED_RULES.map((rule) => ({ ...rule, label: `rule ${rule.id}` })),
  baseline,
  actual,
);

for (const rule of BASELINED_RULES) {
  const allowed = baseline[rule.key] ?? {};
  const current = actual.get(rule.key) ?? new Map();
  const allowedTotal = totalOf(allowed);
  const currentTotal = [...current.values()].reduce((sum, n) => sum + n, 0);

  const over = [];
  for (const [file, count] of current) {
    if (count > (allowed[file] ?? 0)) over.push({ file, budget: allowed[file] ?? 0, count });
  }

  const summary = `allowed=${allowedTotal} now=${currentTotal}`;
  if (over.length === 0) {
    console.log(`  rule ${String(rule.id).padStart(2)}  ${rule.label.padEnd(34)}  ${summary} ✓`);
    continue;
  }

  failed = true;
  console.error(
    `\nguard-invariants: rule ${rule.id} — ${over.length} file(s) over baseline ` +
      `(${rule.label}):\n`,
  );
  for (const { file, budget, count } of over) {
    console.error(`  ${file}  allowed ${budget}, found ${count}`);
    const lines = occurrences.get(rule.key)?.get(file) ?? [];
    for (const { line, text } of lines.slice(0, MAX_SHOWN)) {
      const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
      console.error(`      ${file}:${line}  ${shown}`);
      annotate(file, line, `rule ${rule.id}: ${rule.label} — ${text}`);
    }
    if (lines.length > MAX_SHOWN) console.error(`      … and ${lines.length - MAX_SHOWN} more`);
  }
  console.error(`\n${rule.remedy}\n`);
}

if (failed) {
  console.error(
    "guard-invariants: fix the violation(s) above rather than editing the\n" +
      "baseline. `node scripts/guard-invariants.mjs --rules` prints every rule's\n" +
      "rationale and remedy.",
  );
  process.exit(1);
}

// Every baselined rule at zero against a non-empty baseline is a blind scan
// until proven otherwise — see `_ratchet.mjs`.
assertNotUniversallyEmpty({
  gate: GATE,
  allowedTotal: baselineTotal,
  currentTotal: treeTotal,
  updateCommand: UPDATE_COMMAND,
});

warnStale({ gate: GATE, stale, updateCommand: UPDATE_COMMAND, maxShown: MAX_SHOWN });

console.log(
  `\nguard-invariants: ${ABSOLUTE_RULES.length + BASELINED_RULES.length} rule(s) hold. ✓`,
);
