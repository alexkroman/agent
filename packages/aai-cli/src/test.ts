// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 *
 * The launcher is `_vitest-runner.ts`, shared with `aai eval` and `aai build`'s
 * pre-build gate. What is here is the COMMAND: which files the test tier runs,
 * and the verdict over the ones a run did not cover.
 */

import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { formatCappedList } from "./_utils.ts";
import { classifyVitestError, runVitest, unrunSpecFiles, WIDEN_HINT } from "./_vitest-runner.ts";

/**
 * What `aai test` measured, not merely whether it exited 0.
 *
 * `passed` alone is what made a narrowed run indistinguishable from a complete
 * one in a script (`jq -e .data.passed` was true either way), so the set it
 * covered rides the result: `ran` is what vitest was pointed at, `unrun` is what
 * it was not, and `complete` is the one field a CI job needs to read.
 */
type TestData = {
  passed: boolean;
  skipped?: boolean;
  /** Spec files this run covered, project-relative, code-unit sorted. */
  ran: string[];
  /** Spec files in the project this run did NOT cover — empty when complete. */
  unrun: string[];
  /** Whether the run covered every non-eval spec file in the project. */
  complete: boolean;
};

/**
 * The files a NARROWED `aai test` runs, in preference order.
 *
 * The tier's filenames belong to the command, not to the runner — `aai eval`
 * declares `EVAL_FILES` the same way one module over, and neither names the
 * other's. `aai build` imports this one because its pre-build gate runs the
 * TEST tier.
 *
 * They are no longer what a BARE `aai test` runs — see {@link executeTest} for
 * why the default is the whole project — so this list is now reached only by
 * `--only`.
 */
export const TEST_FILES = ["agent.test.ts", "agent.test.js"] as const;

/** What `aai test` was asked to cover. */
export type TestOptions = {
  /**
   * Narrow the run to {@link TEST_FILES} rather than every non-eval spec.
   *
   * The fast inner loop, and the OPT-IN half of the pair: it is what the old
   * default did, minus the false verdict — a narrowed run reports the specs it
   * skipped through `warnUnrunSpecs` and says `complete: false`.
   */
  readonly only?: boolean | undefined;
};

/**
 * Execute agent tests and return structured result.
 *
 * **The default is the whole project, and it used to be one file.**
 * `aai test` ran `agent.test.ts` alone and then FAILED (`incomplete_run`) over
 * every other spec it had skipped — so on any project with a second spec file
 * the default invocation could never be green, and the scaffold routed around
 * the command it was supposed to wire into CI (`"test": "vitest run --exclude
 * …"`, with `aai test` demoted to `test:agent`). Nine shipped templates carry
 * two or more non-eval specs, so that was the normal case rather than the edge:
 * the command's own remedy was "do not run this command".
 *
 * The narrow default was defensible when it was written — running a project's
 * other specs could reach ones that are slow or want credentials — but the
 * verdict is what made it unusable, and `aai build`'s pre-build gate had
 * already gone the other way (`all: true`) for the same reason a build is run
 * deliberately. So the widening is the default here too and `--only` is the
 * inner loop, which leaves the two halves of the original defect closed: a
 * complete run is a green run, and a narrowed one is honest about what it
 * skipped instead of failing over it.
 *
 * **An incomplete run is still not a pass.** For as long as this command
 * answered `{"ok":true,"data":{"passed":true}}` with exit 0 over specs it had
 * not run, adding one tool could break `registry.test.ts` in 17 assertions with
 * `pnpm test` and `pnpm build` both staying green throughout. What carries that
 * now is the RESULT (`unrun`, `complete: false`) plus the runner's own warning,
 * because the reader of a deliberate `--only` asked for the narrowing.
 */
export async function executeTest(
  cwd: string,
  opts: TestOptions = {},
): Promise<CommandResult<TestData>> {
  const narrowed = opts.only === true;
  log.step(narrowed ? "Running agent tests" : "Running project tests");
  try {
    // `announceUnrun` left at its DEFAULT (on), unlike before: the complete run
    // has nothing to announce, and the narrowed one is exactly the caller that
    // notice was written for. Reporting it here as well would read as two
    // findings.
    const ran = runVitest(cwd, { candidates: TEST_FILES, all: !narrowed });
    const unrun = unrunSpecFiles(cwd, ran);
    if (ran === false) {
      // Nothing to point vitest at. Unreachable for the default invocation with
      // any spec in the project at all, so a non-empty `unrun` here means
      // `--only` narrowed the run down to a file that does not exist.
      if (unrun.length > 0) return noNarrowTarget(unrun);
      log.info("No test file found. Create agent.test.ts to add tests.");
      return ok({ passed: true, skipped: true, ran: [], unrun: [], complete: true });
    }
    log.success(`Tests passed (${ran.length} spec file(s))`);
    return ok({ passed: true, ran, unrun, complete: unrun.length === 0 });
  } catch (err: unknown) {
    const { code, message } = classifyVitestError(err);
    return fail(code, message);
  }
}

/**
 * The verdict for `--only` in a project with no `agent.test.ts`.
 *
 * This is the arm that had misled longest, and it is the one place the
 * `incomplete_run` failure is still right: `aai test` printed "No test file
 * found" while the project's specs sat right there unrun, which reads as "this
 * project has no tests". Measured on a project whose only spec was
 * `tools/echo_back.test.ts` — `{"passed":true,"skipped":true}`, exit 0, and not
 * a word about it. Bare `aai test` runs those specs now; `--only` asked for a
 * file that is not there, and the honest answer is neither a pass nor silence.
 */
function noNarrowTarget(unrun: string[]): CommandResult<never> {
  return fail(
    "incomplete_run",
    `\`aai test --only\` found no ${TEST_FILES[0]}, so it ran nothing, but ${unrun.length} spec file(s) exist: ` +
      `${formatCappedList(unrun)}. An unrun spec is not a passing one, so this is not a green result.`,
    WIDEN_HINT,
  );
}
