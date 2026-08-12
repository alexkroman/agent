/**
 * The PR-comment markdown for an artifact size report.
 *
 * Split out of `artifact-size-report.mjs` at the seam that file already had —
 * measure, compare, render — because it was 19 lines under the 500-line cap and
 * `check:file-length` warns before the cap precisely so the split lands in its
 * own commit rather than inside whatever change would have forced it.
 *
 * Renders from the comparison the report already computed. It deliberately
 * derives NOTHING: every threshold decision lives beside the numbers in
 * `compareReports`, so the markdown a reviewer reads and the pass/fail a job
 * produces cannot disagree — they are the same field of the same JSON.
 */

import {
  formatBytes,
  formatRatioPercent,
  formatSignedBytes,
  SIZE_BUDGET_THRESHOLD,
} from "./artifact-size-format.mjs";

function markdownTable(rows) {
  return rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

/** A signed byte delta, or an em dash when there is no baseline row. */
function deltaCell(comparison) {
  return comparison ? formatSignedBytes(comparison.delta) : "—";
}

/** A signed count delta, or an em dash when unchanged or unavailable. */
function countDeltaCell(comparison) {
  if (!comparison || comparison.delta === 0) return "—";
  return `${comparison.delta > 0 ? "+" : ""}${comparison.delta}`;
}

function renderBundles(bundles) {
  const lines = ["", "### Bundles", ""];
  lines.push(
    markdownTable([
      ["Bundle", "Raw", "Δ", "Gzip", "Δ"],
      ["---", "---:", "---:", "---:", "---:"],
      ...bundles.map((b) => [
        `\`${b.name}\``,
        formatBytes(b.rawBytes),
        deltaCell(b.rawComparison),
        formatBytes(b.gzipBytes),
        deltaCell(b.gzipComparison),
      ]),
    ]),
  );
  for (const b of bundles) {
    if (b.note) lines.push("", `\`${b.name}\` — ${b.note}.`);
  }
  return lines;
}

function renderPackages(packages) {
  return [
    "",
    "### Published packages",
    "",
    markdownTable([
      ["Package", "Packed", "Δ", "Unpacked", "Δ", "Files", "Δ"],
      ["---", "---:", "---:", "---:", "---:", "---:", "---:"],
      ...packages.map((p) => [
        `\`${p.name}\``,
        formatBytes(p.packedBytes),
        deltaCell(p.packedComparison),
        formatBytes(p.unpackedBytes),
        deltaCell(p.unpackedComparison),
        String(p.fileCount),
        countDeltaCell(p.fileCountComparison),
      ]),
    ]),
  ];
}

function renderDependencyChanges(packages) {
  const changed = packages.filter(
    (p) => (p.addedDependencies?.length ?? 0) > 0 || (p.removedDependencies?.length ?? 0) > 0,
  );
  if (changed.length === 0) return [];
  const lines = ["", "### Runtime dependency changes", ""];
  for (const p of changed) {
    for (const d of p.addedDependencies ?? []) lines.push(`- **added** \`${p.name}\` → \`${d}\``);
    for (const d of p.removedDependencies ?? []) lines.push(`- removed \`${p.name}\` → \`${d}\``);
  }
  return lines;
}

function renderBudget(checks, hasBaseline) {
  if (checks.length === 0) return hasBaseline ? ["", "No budget regressions. ✓"] : [];
  const lines = ["", "### ⚠️ Budget", ""];
  for (const check of checks) {
    lines.push(
      check.kind === "runtime-dependency"
        ? `- New runtime dependency \`${check.dependency}\` in \`${check.package}\`. Runtime dependencies land in every consumer's tree — prefer bundling it or moving it to devDependencies.`
        : `- \`${check.metric}\` grew ${formatRatioPercent(check.increaseRatio)} (${formatBytes(check.baseline)} → ${formatBytes(check.current)}), over the ${formatRatioPercent(check.thresholdRatio)} limit.`,
    );
  }
  lines.push(
    "",
    "If the growth is intended, add the `acknowledge-size-warning` label. It is " +
      "removed automatically on the next push, so each commit is acknowledged on " +
      "its own.",
  );
  return lines;
}

export function renderMarkdown(report, comparison) {
  const label = comparison?.baselineLabel;
  return `${[
    "## Artifact size",
    label != null
      ? `Compared against \`${label}\`. A metric growing more than ${formatRatioPercent(SIZE_BUDGET_THRESHOLD)}, or a new runtime dependency, fails the budget.`
      : "_No baseline available — sizes are reported without a comparison._",
    ...renderBundles(comparison?.bundles ?? report.bundles),
    ...renderPackages(comparison?.packages ?? report.packages),
    ...renderDependencyChanges(comparison?.packages ?? report.packages),
    ...renderBudget(comparison?.checks ?? [], label != null),
  ].join("\n")}\n`;
}
