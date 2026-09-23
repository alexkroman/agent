#!/usr/bin/env node

/**
 * Copy-paste ratchet: jscpd's clone detection against a COMMITTED PER-FILE
 * BASELINE.
 *
 * ## Why this exists
 *
 * A bug fixed in one copy of a block and not the other is the most expensive
 * kind of churn a repo can carry, because nothing points at the second copy.
 * This repo already knows it: `scripts/check.mjs` keeps FOUR sync gates alive
 * (`check:scaffold`, `check:guest-toolchain`, `check:agent-guide`,
 * `check:studio-prompt`) for copies somebody noticed and decided to keep. Those
 * are the copies that were FOUND. The ones nobody noticed are the ones a gate has
 * to find, and until this one nothing looked.
 *
 * ## What it measures
 *
 * jscpd (v4, token-based: a clone is at least {@link MIN_TOKENS} identical
 * tokens spanning {@link MIN_LINES}+ lines, whitespace and comments ignored)
 * finds every clone pair in the corpus. The number recorded per file is how many
 * of its source lines sit inside some clone. It may go DOWN (`--update` records
 * that) and may never go up — the same contract as `check:hatches`, and the same
 * machinery (`_ratchet.mjs`). The existing clones are the to-do list; a new one
 * fails with both ends named.
 *
 * ## One property to know before you are surprised by it
 *
 * A clone has two ends. Pasting a block from `a.ts` into `b.ts` raises BOTH
 * files' counts, so the failure can name a file your diff did not touch. The
 * report prints each over-budget file's clone partners with line ranges; the
 * partner in your diff is the copy to remove. Do not "fix" it by raising the
 * untouched file's budget.
 *
 * ## Scope
 *
 * Shipped source under `packages/` plus `scripts/`. Out, each for a reason:
 * tests (a spec restating its arrange block is readable, and test coupling is
 * measured by guard-invariants rule 34 instead), the frozen compatibility
 * examples under `src/contracts/` (MEANT to be written the old way), and the
 * templates and scaffold (each template is copied by a user in isolation, so
 * sharing code between two of them would be the defect).
 *
 * ## Why `createRequire`
 *
 * jscpd 4.3.0's ESM build imports `colors/safe` with no extension, which Node's
 * ESM resolver refuses (`ERR_MODULE_NOT_FOUND`). Its CommonJS entry resolves
 * the same dependency fine, so this loads that one.
 *
 * Wired up as `pnpm check:duplication`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { parseScriptArgs } from "./_args.mjs";
import {
  assertNotUniversallyEmpty,
  compareToBaseline,
  totalOf,
  updateBaseline,
  warnStale,
} from "./_ratchet.mjs";

const require = createRequire(import.meta.url);
const { detectClonesAndStatistic } = require("jscpd");

const BASELINE_PATH = new URL("duplication-baseline.json", import.meta.url);
const GATE = "check-duplication";
const UPDATE_COMMAND = "node scripts/check-duplication.mjs --update";
const KEY = "duplicatedLines";

/** jscpd's own defaults, stated so a change to them is a reviewed diff. */
const MIN_TOKENS = 50;
const MIN_LINES = 5;

/** The floor under the corpus — ~1,250 sources today. */
const MIN_SOURCES = 800;

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/*.d.ts",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test-d.ts",
  "**/src/contracts/**",
  "packages/aai-templates/templates/**",
  "packages/aai-templates/scaffold/**",
];

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { update: { type: "boolean" } },
});

const { clones, statistic } = await detectClonesAndStatistic({
  path: ["packages", "scripts"],
  format: ["typescript", "tsx", "javascript"],
  formatsExts: { typescript: ["ts", "mts"], tsx: ["tsx"], javascript: ["mjs"] },
  ignore: IGNORE,
  gitignore: true,
  minTokens: MIN_TOKENS,
  minLines: MIN_LINES,
  silent: true,
  reporters: [],
  absolute: false,
  noTips: true,
});

const sources = statistic?.total?.sources ?? 0;
if (sources < MIN_SOURCES) {
  console.error(
    `${GATE}: jscpd scanned ${sources} source(s), under the floor of ${MIN_SOURCES}. ` +
      "A path or format stopped matching — a clone scan of nothing reports no clones.",
  );
  process.exit(1);
}

/** file -> Set of duplicated line numbers */
const covered = new Map();
/** file -> [{ own: "a-b", other, at: "c-d" }] */
const partners = new Map();
const addRange = (file, from, to) => {
  const set = covered.get(file) ?? new Set();
  covered.set(file, set);
  for (let line = from; line <= to; line++) set.add(line);
};
const addPartner = (file, entry) => {
  const list = partners.get(file);
  if (list === undefined) partners.set(file, [entry]);
  else list.push(entry);
};
for (const { duplicationA: a, duplicationB: b } of clones) {
  addRange(a.sourceId, a.start.line, a.end.line);
  addRange(b.sourceId, b.start.line, b.end.line);
  const spanA = `${a.start.line}-${a.end.line}`;
  const spanB = `${b.start.line}-${b.end.line}`;
  addPartner(a.sourceId, { own: spanA, other: b.sourceId, at: spanB });
  addPartner(b.sourceId, { own: spanB, other: a.sourceId, at: spanA });
}

const groups = [{ key: KEY, label: "duplicated lines" }];
const counts = new Map([[KEY, new Map([...covered].map(([file, set]) => [file, set.size]))]]);
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

if (FLAGS.update === true) {
  updateBaseline({
    gate: GATE,
    baselinePath: BASELINE_PATH,
    baseline,
    groups,
    counts,
    advice:
      "The baseline only ratchets down. Extract the shared block into one module\n" +
      "both callers import. If a copy is genuinely deliberate (two packages that\n" +
      "must not depend on each other), raise the number by hand and say why in\n" +
      "the PR — the increase then shows up in the diff.",
  });
}

const { violations, stale, allowedTotal, currentTotal } = compareToBaseline(
  groups,
  baseline,
  counts,
);

const delta = currentTotal - allowedTotal;
console.log(
  `${GATE}: ${sources} sources, ${clones.length} clone(s) of >=${MIN_TOKENS} tokens\n` +
    `  duplicated lines  allowed=${allowedTotal}  now=${currentTotal}  ` +
    `(${delta >= 0 ? "+" : ""}${delta})  files=${covered.size}`,
);

if (violations.length > 0) {
  console.error(`\n${GATE}: ${violations.length} file(s) over their baseline:\n`);
  for (const { file, budget, count } of violations) {
    console.error(`  ${file}  allowed ${budget}, found ${count}`);
    for (const { own, other, at } of (partners.get(file) ?? []).slice(0, 10)) {
      console.error(`      ${file}:${own}  ≡  ${other}:${at}`);
    }
  }
  console.error(
    "\nA block now appears in two places. Extract it into one module both callers\n" +
      "import — the partner listed above is the other copy. A file your diff did not\n" +
      "touch can appear here: a clone has two ends, and pasting INTO a.ts from b.ts\n" +
      "raises both. Remove your copy rather than raising the untouched file's budget.\n" +
      "If the copy is genuinely deliberate, raise the number in\n" +
      "scripts/duplication-baseline.json by hand and say why in the PR.\n",
  );
  process.exit(1);
}

assertNotUniversallyEmpty({
  gate: GATE,
  allowedTotal,
  currentTotal,
  updateCommand: UPDATE_COMMAND,
});
warnStale({ gate: GATE, stale, updateCommand: UPDATE_COMMAND, maxShown: 20 });

console.log(`\n${GATE}: every file within its baseline (${totalOf(baseline[KEY])} allowed). ✓`);
