// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai eval` — run the agent's behaviour evals via vitest.
 *
 * An eval is not a test, and this is a separate command rather than part of
 * `aai test` for the three reasons that follow from that:
 *
 * - **It spends money.** Every case drives a real LLM on a real key, so it
 *   cannot run on every save, in `aai build`, or in a pre-commit hook the way
 *   the unit tests do.
 * - **It is a noisy instrument.** A behaviour eval measures a probabilistic
 *   system: identical code has scored 0.56 and 0.60 on the same task set with
 *   9 of 25 tasks flipping outcome. A green run is weaker evidence than a green
 *   test run, and a red one is not automatically a regression. Mixing the two
 *   into one verdict devalues the reliable half.
 * - **It is slow by construction** — one model turn per utterance. Hence the
 *   per-case budget below rather than vitest's 5s default, which no case that
 *   waits on a live reply can meet.
 *
 * What it runs is an ordinary vitest file, `agent.eval.test.ts`, which is why
 * there is no eval DSL here: the project already has a runner, and the harness
 * that makes an agent drivable from text is published
 * (`@alexkroman1/aai-runtime/eval`).
 */

import { type CommandResult, fail, ok } from "./_output.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";
import { classifyVitestError, runVitest } from "./test.ts";

type EvalData = { passed: boolean; skipped?: boolean };

/** The files `aai eval` runs, in preference order. */
export const EVAL_FILES = ["agent.eval.test.ts", "agent.eval.test.js"] as const;

/**
 * How long one eval case may run.
 *
 * Vitest's default is 5s, which is shorter than a single live model turn on a
 * slow day — so without this every case fails as a timeout and the report says
 * nothing about the agent. Generous rather than tuned: the harness has its own
 * 90s per-turn timeout with a message naming the events it saw, and that is the
 * diagnostic worth reaching. This ceiling only exists so a wedged run ends.
 */
export const EVAL_TEST_TIMEOUT_MS = 300_000;

/** Execute the agent's evals and return a structured result. */
export async function executeEval(cwd: string): Promise<CommandResult<EvalData>> {
  log.step("Running agent evals");
  // The project's `.env`, resolved exactly as `aai dev` resolves it (declared
  // keys only, shell wins) and handed to the child. Without it an eval sees the
  // shell alone, so a developer whose key lives in `.env` — which is where this
  // CLI puts it — would watch every case skip for want of a credential the
  // agent itself runs fine with.
  const env = await resolveServerEnv(cwd);
  try {
    const ran = runVitest(cwd, {
      candidates: EVAL_FILES,
      extraArgs: ["--testTimeout", String(EVAL_TEST_TIMEOUT_MS)],
      env,
    });
    if (!ran) {
      log.info(
        "No eval file found. Create agent.eval.test.ts to measure what the agent does — " +
          "see `openEvalSession` in @alexkroman1/aai-runtime/eval.",
      );
      return ok({ passed: true, skipped: true });
    }
    log.success("Evals passed");
    return ok({ passed: true });
  } catch (err: unknown) {
    const { code, message } = classifyVitestError(err, "Evals");
    return fail(code, message);
  }
}
