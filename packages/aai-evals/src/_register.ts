// Copyright 2026 the AAI authors. MIT license.
/**
 * Registering eval cases with vitest — the one place the tier decides what it
 * ASSERTS, as opposed to what it measures.
 *
 * Exactly two things are asserted, and neither is a behaviour claim:
 *
 * - **the harness worked.** A dead sandbox, an unreachable studio or a provider
 *   outage is a failure of the measurement, not of the agent, and averaging the
 *   two hides both.
 * - **an explicitly requested floor was cleared** (`AAI_EVAL_MIN_SCORE`),
 *   against the spread's LOWER bound. Unset — the default, and how it should
 *   stay until the variance work exists — nothing gates.
 *
 * A failed behaviour assertion is therefore DATA: it lands in the report, in the
 * flip list if it is not unanimous, and in the recurring-failure grouping. See
 * `runner.ts` for why a measurably noisy instrument must not block a merge.
 *
 * It is a module rather than a helper inside each eval file for a mechanical
 * reason worth knowing: Biome's `noMisplacedAssertion` accepts an `expect` only
 * inside a literal `test(`/`it(` call, so an `expect` reached through a
 * `const run = matches ? test : test.skip` alias — or through
 * `test.skipIf(…)(…)` — is a lint error. Registration therefore happens once,
 * here, over a list of cases.
 *
 * @module
 */

import { afterAll, expect, test } from "vitest";
import { evalOnly, sayFromHarness } from "./_gate.ts";
import { evalShortfalls, formatEvalReport } from "./report.ts";
import { type EvalReport, type EvalSpec, evalMinScore, runEval } from "./runner.ts";

/** One case: a stable name and the body that drives a target. */
export type EvalCase = { readonly name: string; readonly body: EvalSpec["body"] };

/**
 * Register every case, filtered by `AAI_EVAL_ONLY`, and print the run's report
 * once they have all finished.
 *
 * A file the filter selects nothing from WARNS, naming its own cases, and
 * registers nothing. It deliberately does not FAIL, and the first draft did:
 * `AAI_EVAL_ONLY` is one variable across the whole tier while each eval file
 * sees only its own cases and vitest gives them separate workers, so "no case
 * here matched" cannot tell a mistyped filter from a filter aimed at the other
 * file — `AAI_EVAL_ONLY="math tutor"` correctly selected one starter and failed
 * the level-1 file for not containing it. A typo therefore ends in a run with
 * zero cases and one warning per file listing what it could have matched, which
 * is loud enough while being right.
 */
/**
 * Does `AAI_EVAL_ONLY` select a case by this name?
 *
 * Exported because the starter eval has a PRECONDITION of its own — a 3-second
 * `/health` probe of the studio origin — and it was paying it unconditionally,
 * so `AAI_EVAL_ONLY` aimed at a level-1 case made that file probe and then
 * announce a skip about a run nobody asked for. One predicate, so the file's
 * gate and this registration cannot select differently.
 */
export function evalOnlySelects(name: string): boolean {
  const only = evalOnly();
  return only === undefined || name.toLowerCase().includes(only.toLowerCase());
}

export function registerEvalCases(cases: readonly EvalCase[]): void {
  const reports: EvalReport[] = [];
  afterAll(() => {
    // The tier's whole product, on stdout as `console.log` had it — see
    // `sayFromHarness` for why it is not `console.log` any more.
    if (reports.length > 0) sayFromHarness(`\n${formatEvalReport(reports)}\n`, "out");
  });

  const only = evalOnly();
  const selected = only === undefined ? cases : cases.filter((c) => evalOnlySelects(c.name));

  if (selected.length === 0) {
    sayFromHarness(
      `\n[AAI_EVAL_ONLY=${only}] no case in this file matched. Its cases:\n` +
        `${cases.map((c) => `  - ${c.name}`).join("\n")}\n`,
    );
    // A registered, PASSING test rather than nothing: vitest fails a file whose
    // suite holds no test at all ("No test found in suite"), so registering
    // nothing would turn a legitimately-filtered file into a red run — the same
    // cross-file confusion the note above describes, arriving by another route.
    // It names the situation in the reporter; the warning above carries the list.
    test(`AAI_EVAL_ONLY=${only} selects no case in this file`, () => {
      expect(selected).toEqual([]);
    });
    return;
  }

  for (const evalCase of selected) {
    test(evalCase.name, async () => {
      const report = await runEval({ name: evalCase.name, body: evalCase.body });
      reports.push(report);
      expect(report.passes.flatMap((p) => (p.error === undefined ? [] : [p.error]))).toEqual([]);
      expect(evalShortfalls([report], evalMinScore())).toEqual([]);
    });
  }
}
