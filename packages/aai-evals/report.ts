// Copyright 2026 the AAI authors. MIT license.
/**
 * Rendering an eval run: a spread per case, and every failing assertion.
 *
 * Two properties carried over from the runner this replaced
 * (`scripts/starter-eval/report.mjs`), because both were load-bearing there:
 *
 * - **A recurring failure is grouped.** One signature hitting several cases is a
 *   framework problem; the same text printed five times reads as five unrelated
 *   one-offs. Signatures collapse identifiers, numbers and quoted strings so two
 *   instances of one defect land together.
 * - **The spread is the headline, never the mean.** `0.60 (0.56–0.60, ±0.04)` and
 *   `0.60` are the same mean and completely different results; printing the
 *   second is how a lucky repeat gets read as an improvement.
 *
 * @module
 */

import { plural } from "@alexkroman1/aai/utils";
import type { EvalCheck, EvalReport } from "./runner.ts";

/** Collapse a failure detail to a comparable signature. */
export function signature(text: string): string {
  return text
    .replace(/'[^']*'/g, "'X'")
    .replace(/"[^"]*"/g, '"X"')
    .replace(/\b[0-9a-f]{8,}\b/gi, "ID")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

/** One grouped failure signature. */
export type FailureGroup = {
  readonly signature: string;
  readonly count: number;
  /** Case names this signature appeared in, in first-seen order. */
  readonly cases: readonly string[];
  readonly sample: string;
};

/** One failing check as the line a reader sees, label and detail together. */
function checkLine(check: EvalCheck): string {
  return `${check.label}${check.detail === undefined ? "" : ` — ${check.detail}`}`;
}

type GroupEntry = { count: number; cases: string[]; sample: string };

/** Every failing check of a report, as `[signature, line]` pairs. */
function failureLines(report: EvalReport): [string, string][] {
  return report.passes.flatMap((pass) =>
    pass.checks
      .filter((check) => !check.ok)
      .map((check): [string, string] => {
        const line = checkLine(check);
        return [signature(line), line];
      }),
  );
}

/** Group every failing assertion's detail across a run, most common first. */
export function failureGroups(reports: readonly EvalReport[]): FailureGroup[] {
  const groups = new Map<string, GroupEntry>();
  for (const report of reports) {
    for (const [key, line] of failureLines(report)) {
      const entry = groups.get(key) ?? { count: 0, cases: [], sample: line };
      entry.count += 1;
      if (!entry.cases.includes(report.name)) entry.cases.push(report.name);
      groups.set(key, entry);
    }
  }
  return [...groups]
    .map(([sig, entry]) => ({ signature: sig, ...entry }))
    .sort((a, b) => b.count - a.count);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * `mean (min–max, ±spread)`, or a bare number when one pass was measured.
 *
 * Keyed on `measuredPasses`, not `passes.length`: the score is computed over the
 * passes that did not die, so five repeats of which four were harness errors is
 * a SINGLE measurement and printing `±0%` for it would claim a stability nobody
 * observed. With none measured there is no number at all, and saying so beats
 * printing the 0% that an empty spread produces.
 */
export function formatSpread(report: EvalReport): string {
  if (report.measuredPasses === 0) return "not measured";
  const { min, max, mean, spread } = report.score;
  if (report.measuredPasses === 1) return pct(mean);
  return `${pct(mean)} (${pct(min)}–${pct(max)}, ±${pct(spread)})`;
}

/** Every failing assertion of one case, deduplicated across repeats. */
function failedChecks(report: EvalReport): EvalCheck[] {
  const seen = new Map<string, EvalCheck>();
  for (const pass of report.passes) {
    for (const check of pass.checks) {
      if (!(check.ok || seen.has(check.label))) seen.set(check.label, check);
    }
  }
  return [...seen.values()];
}

/**
 * The whole run as text: one block per case, then the grouped signatures.
 *
 * Written for stdout in a vitest run rather than for a JSON consumer, because
 * the tier's output is READ — the thing it exists to produce is a judgement
 * about whether a change moved anything, and that is made by a person looking
 * at a spread.
 */
export function formatEvalReport(reports: readonly EvalReport[]): string {
  const lines = reports.flatMap(formatCase);
  const groups = failureGroups(reports).filter((g) => g.count > 1);
  if (groups.length > 0) {
    lines.push("", "RECURRING FAILURES (most common first)");
    for (const group of groups) {
      lines.push(`  ${group.count}x  ${group.signature}`, `      cases: ${group.cases.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** One case: its headline, its failures, its flip list, its harness errors. */
function formatCase(report: EvalReport): string[] {
  const repeats = report.passes.length;
  const lines = [
    `${report.name}  score ${formatSpread(report)}  ` +
      `${repeats} ${plural(repeats, "repeat")}  ` +
      `${Math.round(report.ms.mean / 1000)}s/pass` +
      (report.harnessErrors > 0 ? `  HARNESS ERRORS ${report.harnessErrors}` : ""),
    ...failedChecks(report).map((check) => `  FAIL ${checkLine(check)}`),
  ];
  if (report.unstable.length > 0) {
    lines.push(`  UNSTABLE across repeats: ${report.unstable.join(", ")}`);
  }
  for (const pass of report.passes) {
    if (pass.error !== undefined) lines.push(`  HARNESS r${pass.repeat}: ${pass.error}`);
  }
  return lines;
}

/**
 * When `minScore` is set, name the cases that did not clear it.
 *
 * Returns the offending cases rather than printing or throwing, so the caller
 * decides whether the tier gates. It does not gate by default — see `runner.ts`.
 */
export function evalShortfalls(
  reports: readonly EvalReport[],
  minScore: number | undefined,
): string[] {
  if (minScore === undefined) return [];
  return reports
    .filter((r) => r.score.min < minScore)
    .map((r) => `${r.name}: worst repeat ${pct(r.score.min)} < ${pct(minScore)}`);
}
