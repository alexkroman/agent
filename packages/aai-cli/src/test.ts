// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 *
 * The launcher is `_vitest-runner.ts`, shared with `aai eval` and `aai build`'s
 * pre-build gate. What is here is the COMMAND: which files the test tier runs,
 * and the verdict over the ones a run did not cover.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
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
 * The files `aai test` runs, in preference order.
 *
 * The tier's filenames belong to the command, not to the runner — `aai eval`
 * declares `EVAL_FILES` the same way one module over, and neither names the
 * other's. `aai build` imports this one because its pre-build gate runs the
 * TEST tier.
 */
export const TEST_FILES = ["agent.test.ts", "agent.test.js"] as const;

/** What `aai test` was asked to cover. */
export type TestOptions = {
  /** Run every non-eval spec in the project rather than `agent.test.ts` alone. */
  readonly all?: boolean | undefined;
};

/**
 * Execute agent tests and return structured result.
 *
 * **An incomplete run is not a pass.** For as long as this command answered
 * `{"ok":true,"data":{"passed":true}}` with exit 0 over specs it had not run,
 * the scaffold's `"test": "aai test"` was what users wired into CI — so a suite
 * of 25 tests could go red in the editor and green in the pipeline, and adding
 * one tool could break `registry.test.ts` in 17 assertions with `pnpm test` and
 * `pnpm build` both staying green throughout. It is the same defect
 * `defineExec`'s `cwd` policy exists for (a green result for a project that is
 * not there), one directory over, and it gets the same answer: the command
 * fails, names the files, and names the flag that runs them.
 */
export async function executeTest(
  cwd: string,
  opts: TestOptions = {},
): Promise<CommandResult<TestData>> {
  log.step(opts.all ? "Running project tests" : "Running agent tests");
  try {
    // `announceUnrun: false`: this function reports the same set itself, in the
    // result as well as the output, and reporting it twice reads as two findings.
    const ran = runVitest(cwd, {
      candidates: TEST_FILES,
      announceUnrun: false,
      ...omitUndefined({ all: opts.all }),
    });
    const unrun = unrunSpecFiles(cwd, ran);
    if (unrun.length > 0) return incomplete(ran, unrun);
    if (ran === false) {
      log.info("No test file found. Create agent.test.ts to add tests.");
      return ok({ passed: true, skipped: true, ran: [], unrun: [], complete: true });
    }
    log.success(`Tests passed (${ran.length} spec file(s))`);
    return ok({ passed: true, ran, unrun: [], complete: true });
  } catch (err: unknown) {
    const { code, message } = classifyVitestError(err);
    return fail(code, message);
  }
}

/**
 * The verdict for a run that left specs uncovered.
 *
 * Both arms fail, and the `ran === false` arm is the one that had misled
 * longest: `aai test` printed "No test file found" while the project's specs sat
 * right there unrun, which reads as "this project has no tests". Measured on a
 * project whose only spec was `tools/echo_back.test.ts` — `{"passed":true,
 * "skipped":true}`, exit 0, and not a word about it.
 */
function incomplete(ran: string[] | false, unrun: string[]): CommandResult<never> {
  const preamble =
    ran === false
      ? `\`aai test\` found no agent.test.ts, so it ran nothing, but ${unrun.length} spec file(s) exist`
      : `\`aai test\` ran ${ran.join(", ")} only — ${unrun.length} other spec file(s) in this project were not run`;
  return fail(
    "incomplete_run",
    `${preamble}: ${formatCappedList(unrun)}. An unrun spec is not a passing one, so this is not a green result.`,
    WIDEN_HINT,
  );
}
