#!/usr/bin/env node

/**
 * Fail when a size report's budget checks fired.
 *
 * Split from `artifact-size-report.mjs` on purpose: the workflow posts the PR
 * comment first and enforces afterwards, so a reviewer reads the numbers in the
 * thread rather than digging them out of a failed job's log. The checks
 * themselves are computed next to the measurements — this script only decides
 * what to do about them, so the comment and the pass/fail can never disagree.
 *
 * ## The acknowledgement label
 *
 * Some growth is the point of the change. Every other ratchet in this repo says
 * "baselines only move down", which is right for debt and wrong for size: a
 * feature that legitimately adds 15% has no debt to remove, so the author's only
 * options would be to abandon the gate or to weaken the threshold for everyone.
 *
 * So `--acknowledged` (driven by the `acknowledge-size-warning` label) demotes
 * the failure to a warning. The workflow REMOVES the label on every push, so an
 * acknowledgement covers one commit and not the branch — otherwise the first
 * intentional regression would silently license every later one.
 *
 *   node scripts/artifact-size-budget.mjs --report-json report.json [--acknowledged]
 */

import { readFileSync } from "node:fs";

import { formatBytes, formatRatioPercent, REPORT_KIND } from "./artifact-size-format.mjs";

function parseArgs(argv) {
  const args = { acknowledged: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--acknowledged") {
      args.acknowledged = true;
      continue;
    }
    if (argv[i] === "--report-json") {
      args.reportJson = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function describe(check) {
  if (check.kind === "runtime-dependency") {
    return (
      `New runtime dependency \`${check.dependency}\` in ${check.package}. ` +
      "Runtime dependencies are transitive — they land in every consumer's tree — " +
      "so prefer bundling the code or moving it to devDependencies."
    );
  }
  return (
    `${check.metric} grew ${formatRatioPercent(check.increaseRatio)} ` +
    `(${formatBytes(check.baseline)} -> ${formatBytes(check.current)}), ` +
    `over the ${formatRatioPercent(check.thresholdRatio)} limit.`
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.reportJson === undefined) {
  console.error("artifact-size-budget: --report-json <path> is required.");
  process.exit(1);
}

const report = JSON.parse(readFileSync(args.reportJson, "utf8"));
if (report.kind !== REPORT_KIND) {
  console.error(
    `artifact-size-budget: report has kind "${report.kind}", expected "${REPORT_KIND}".`,
  );
  process.exit(1);
}

// No comparison means no baseline was available (a first run, or a base build
// that failed). That is reported, never treated as a pass with teeth: a gate
// that silently approves whenever its input is missing is the failure shape this
// repo keeps finding.
if (report.comparison == null) {
  console.log(
    "artifact-size-budget: no baseline comparison in the report — nothing to enforce.\n" +
      "  (If this was a pull request, the base build failed; see the job summary.)",
  );
  process.exit(0);
}

const checks = report.comparison.checks ?? [];
if (checks.length === 0) {
  console.log("artifact-size-budget: no regressions. ✓");
  process.exit(0);
}

const heading = args.acknowledged
  ? `artifact-size-budget: ${checks.length} regression(s), ACKNOWLEDGED by label:`
  : `artifact-size-budget: ${checks.length} regression(s):`;
const log = args.acknowledged ? console.warn : console.error;

log(`\n${heading}\n`);
for (const check of checks) log(`  - ${describe(check)}`);

if (args.acknowledged) {
  console.warn(
    "\nAcknowledged, so this is a warning. The label is removed on the next push,\n" +
      "so the following commit has to be acknowledged on its own.\n",
  );
  process.exit(0);
}

console.error(
  "\nIf the growth is intended, add the `acknowledge-size-warning` label to the\n" +
    "pull request. Do not raise the threshold — it is shared by every artifact.\n",
);
process.exit(1);
