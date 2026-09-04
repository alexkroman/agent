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
import type { EvalCheck, EvalReport, EvalSpread } from "./runner.ts";

/**
 * One line of at most `max` characters — how every `EvalCheck.detail` is made.
 *
 * This module owns the presentation of that field, so the rule lives here: it
 * was written out twice, `studio-target.ts` capping at 600 and
 * `template-contract.ts` at 800, with byte-identical bodies. The caps are the
 * tier's readability contract and there was no place to change one — and
 * {@link signature} truncates again at 110 for grouping, so a producer widening
 * its own cap silently changes which failures group together.
 *
 * `slice` BEFORE the collapse: a wedged vitest run or a full `tsc` dump is
 * hundreds of kilobytes, and running `/\s+/g` over all of it to keep 800
 * characters is the whole string walked for nothing. The headroom multiple is
 * what lets the collapse still shorten runs of whitespace inside the kept part.
 */
export function condense(text: string, max: number): string {
  return text
    .slice(0, max * 8)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** How much of a signature is compared when grouping recurring failures. */
const MAX_SIGNATURE = 110;

/** Collapse a failure detail to a comparable signature. */
export function signature(text: string): string {
  return condense(
    text
      .replace(/'[^']*'/g, "'X'")
      .replace(/"[^"]*"/g, '"X"')
      .replace(/\b[0-9a-f]{8,}\b/gi, "ID")
      .replace(/\b\d+\b/g, "N"),
    MAX_SIGNATURE,
  );
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
      // Insert only on a MISS: the `?? {…}` form allocated an entry object for
      // every failing line, hit or not, and re-`set` the map each time.
      let entry = groups.get(key);
      if (entry === undefined) {
        entry = { count: 0, cases: [], sample: line };
        groups.set(key, entry);
      }
      entry.count += 1;
      if (!entry.cases.includes(report.name)) entry.cases.push(report.name);
    }
  }
  return [...groups]
    .map(([sig, entry]) => ({ signature: sig, ...entry }))
    .sort((a, b) => b.count - a.count);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

/**
 * `mean (min–max, ±spread)`, or a bare number when one pass was measured.
 *
 * Keyed on `measuredPasses`, not `passes.length`: the score is computed over the
 * passes that did not die, so five repeats of which four were harness errors is
 * a SINGLE measurement and printing `±0%` for it would claim a stability nobody
 * observed. With none measured there is no number at all, and saying so beats
 * printing the 0% that an empty spread produces.
 *
 * Takes a {@link EvalSpread} and a formatter rather than an {@link EvalReport},
 * because it used to read only `report.score` — so the LATENCY axis, which
 * carries a fully-computed spread of its own, was printed by {@link formatCase}
 * as a bare mean. This module's rule is "the spread is the headline, never the
 * mean", and this package's own measurement is that at level-1 scope the score
 * is not the noisy thing, latency is (46s / 93s / 70s over identical code).
 * Both axes now go through one function, so the two branches above apply to
 * each by construction.
 */
export function formatSpread(
  { min, max, mean, spread }: EvalSpread,
  measuredPasses: number,
  fmt: (n: number) => string,
): string {
  if (measuredPasses === 0) return "not measured";
  if (measuredPasses === 1) return fmt(mean);
  return `${fmt(mean)} (${fmt(min)}–${fmt(max)}, ±${fmt(spread)})`;
}

/** {@link formatSpread} over a report's score. */
export function formatScore(report: EvalReport): string {
  return formatSpread(report.score, report.measuredPasses, pct);
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
    `${report.name}  score ${formatScore(report)}  ` +
      `${repeats} ${plural(repeats, "repeat")}  ` +
      `${formatSpread(report.ms, report.measuredPasses, secs)}/pass` +
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
