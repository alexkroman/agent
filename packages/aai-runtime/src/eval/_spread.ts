// Copyright 2026 the AAI authors. MIT license.
/**
 * A suite's steadiness across repeats, and the runner that measures it.
 *
 * Its own module because BOTH doors need it — `describeEval` and
 * `describeWorkflowEval` — and a second copy is how the two would come to
 * report differently about the same thing. It began inside `describe.ts`, where
 * the workflow door could not reach it, so `AAI_EVAL_REPEAT` covered the
 * twenty-three session suites and none of the five workflow ones: `pnpm
 * test:eval:templates --repeat 3` printed a spread for most of the tier and
 * silently ran the rest once.
 *
 * @module
 */

import { afterAll } from "vitest";
import { announceEvalMode } from "./_announce.ts";

/**
 * One case's outcome across its repeats: how many ran, how many threw.
 *
 * The FIRST failure is kept rather than the last, because a case that fails
 * every repeat has one story and the earliest telling of it is the one whose
 * stack has not been walked over by a later teardown.
 */
type CaseSpread = { readonly name: string; ran: number; failed: number; first?: unknown };

/**
 * What a suite learned about its own steadiness, and the line it prints.
 *
 * ## Why a REPORT rather than more failures
 *
 * With `AAI_EVAL_REPEAT` set, a case that fails some repeats and passes others
 * has told you something a boolean cannot: it is a coin toss, not a defect. So
 * the rule here is the one `aai-evals` already applies to its own tier — a case
 * that failed EVERY repeat fails, and a case that was merely non-unanimous is
 * reported as UNSTABLE and does not.
 *
 * That is safe for three reasons worth stating together, because each on its own
 * looks like a loophole:
 *
 * - it is OPT-IN. Unset, `evalRepeat()` is 1, every case is unanimous by
 *   definition, and a single failure is still a failure.
 * - CI gates the SCRIPTED run, where the model is a script and a repeat cannot
 *   disagree with itself.
 * - the live tier reports and does not gate at all — AGENTS.md says so in as
 *   many words, because a measurably noisy instrument must not block a merge.
 *
 * What it buys is the judgement this tier otherwise makes by hand: eight full
 * live passes were run over one afternoon and their failure MEMBERSHIP diffed,
 * to learn that one 90-second timeout was noise while two chain cases were real.
 * That is what this prints.
 */
export class SuiteSpread {
  private readonly cases = new Map<string, CaseSpread>();
  private readonly suite: string;

  // An explicit field and assignment rather than a parameter property, which
  // `erasableSyntaxOnly` forbids: that syntax emits code, and this repo's
  // TypeScript is type-erasure only.
  constructor(suite: string) {
    this.suite = suite;
  }

  /** Record one repeat's outcome, and hand back the case's running tally. */
  record(name: string, error: unknown): CaseSpread {
    const at = this.cases.get(name) ?? { name, ran: 0, failed: 0 };
    at.ran += 1;
    if (error !== undefined) {
      at.failed += 1;
      at.first ??= error;
    }
    this.cases.set(name, at);
    return at;
  }

  /**
   * The suite's spread, once every case has run.
   *
   * Registered as an `afterAll` from inside `describe`, so it prints after the
   * cases and not after their REGISTRATION — the whole map is empty at
   * definition time.
   */
  report(): void {
    afterAll(() => {
      const repeated = [...this.cases.values()].filter((one) => one.ran > 1);
      if (repeated.length === 0) return;
      const unstable = repeated.filter((one) => one.failed > 0 && one.failed < one.ran);
      const runs = repeated[0]?.ran ?? 1;
      announceEvalMode(
        `eval: ${this.suite} — ${runs} repeats of ${repeated.length} case(s); ` +
          (unstable.length === 0
            ? "every case unanimous."
            : `${unstable.length} UNSTABLE (a pass rate, and the failure each one saw):`),
      );
      // The MESSAGE, on its own line per case. A rate says a case is a coin
      // toss and nothing about which way it lands, so the first draft of this
      // report left a reader knowing there was something to fix and not what —
      // and vitest prints nothing for a case that passed overall.
      for (const one of unstable) {
        const why = one.first instanceof Error ? one.first.message : String(one.first);
        announceEvalMode(
          `eval: ${this.suite} —   ${one.name} (${one.ran - one.failed}/${one.ran}): ` +
            `${why.split("\n")[0]}`,
        );
      }
    });
  }
}

/**
 * Run one case `repeat` times, failing only on a case that never passed.
 *
 * The repeats are SEQUENTIAL and each `run()` opens and closes its own world,
 * because both doors install process-global stubs and tear them down in a
 * `finally` — two at once would share one cursor through the same script.
 */
export async function runRepeats(
  run: () => Promise<void>,
  name: string,
  repeat: number,
  spread: SuiteSpread,
): Promise<void> {
  let tally: CaseSpread | undefined;
  for (let i = 0; i < repeat; i += 1) {
    let error: unknown;
    try {
      await run();
    } catch (err: unknown) {
      // `undefined` is this tally's "passed", so a body that threw it — which
      // `expect` never does, but a bare `throw undefined` would — must not read
      // as a pass.
      error = err ?? new Error("the case threw undefined");
    }
    tally = spread.record(name, error);
  }
  // Unanimously failed, so it is a finding and not a coin toss. Rethrow the
  // FIRST failure: it is the one whose message describes the run that produced
  // it, and vitest prints it exactly as a single-run failure.
  if (tally !== undefined && tally.failed === tally.ran) throw tally.first;
}
