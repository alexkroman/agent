// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio starter eval, on the shared runner.
 *
 * This is `scripts/starter-eval/run.mjs`'s case loop, verdict and reporter —
 * `run.mjs` (485 lines), `report.mjs` (175) and `regrade.mjs` (85) — replaced by
 * the tier's own machinery. What did NOT move is the grading: those checks read
 * generated SOURCE rather than behaviour, which is a different job, and they
 * stay in `scripts/starter-eval/expectations.mjs` where `builtins.mjs` still
 * imports them.
 *
 * Three properties survive the move intact, each of which was learned the hard
 * way there:
 *
 * - **Shippable, not just green.** The coding agent writes its own tests, so
 *   "the tests passed" is a measure it can satisfy by weakening an assertion.
 *   The verdict is whether the built agent covers what the PROMPT enumerated,
 *   checked against the loaded config and `agent.ts` — neither of which the
 *   agent can edit to make the check pass.
 * - **A failure taxonomy**, because "RED" hid three problems wanting three
 *   different fixes: never verified, verified-and-broken, and out of steps.
 * - **Repeats, because run-to-run variance swamps a prompt edit.** Measured on
 *   one starter with an identical config: tool calls varied 9–14 and repairs
 *   1–4. `AAI_EVAL_REPEAT=3` and read the spread; the runner's `unstable` list
 *   is what says whether a check can adjudicate anything yet.
 *
 * `regrade.mjs`'s job — re-grade a SAVED run with today's expectations — is not
 * reproduced. It existed because the grader was corrected four times after the
 * runs it should have applied to, and the cheap version of that is now
 * `starter-expectations.test.ts`, which fails a grader that contradicts its own
 * prompts in the ordinary unit run.
 *
 * @module
 */

import { STARTERS } from "aai-studio-client/starters";
import {
  checkCapabilities,
  checkMode,
  checkUi,
  checkWorkflowShape,
  EXPECTATIONS,
  parseLoadedConfig,
} from "../../scripts/starter-eval/expectations.mjs";
import { describeEvalTierWhen, evalApiKey, evalOrigin } from "./_gate.ts";
import { registerEvalCases } from "./_register.ts";
import type { EvalRecorder } from "./runner.ts";
import { createStudioClient, type StudioTurn } from "./studio-target.ts";

/** Roughly the studio's `MAX_CHAT_STEPS`; only used to flag a long run. */
const STEP_CAP_HINT = Number(process.env.AAI_STEP_CAP_HINT ?? 80);

/** How long the studio-reachability probe waits. */
const PROBE_MS = 3000;

/**
 * Is a studio serving at `origin`?
 *
 * Probed rather than assumed, for the reason `_gate.ts` exists: with a key but
 * no studio every case would fail as a HARNESS error, which reads like the
 * codegen being broken. The announcing and the `AAI_REQUIRE_EVAL` hard failure
 * are `describeEvalTierWhen`'s — this file states the precondition, not the policy.
 */
async function studioReachable(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(PROBE_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

const ORIGIN = evalOrigin();

/** Every starter, with the project KIND that selects its coding-agent prompt. */
const STARTER_CASES = Object.entries(STARTERS).flatMap(([kind, list]) =>
  list.map((starter) => ({ ...starter, kind })),
);

/**
 * Grade one turn, recording every check.
 *
 * The failure taxonomy is the label set, so a report names which of the three
 * problems a case hit rather than reporting one "shippable" bit.
 */
function gradeStarter(
  t: EvalRecorder,
  label: string,
  kind: string,
  turn: StudioTurn,
  files: Record<string, string> | undefined,
): void {
  const last = turn.testAgentRuns.at(-1);
  const built = last !== undefined && !last.buildFailed && !last.testsFailed;
  const source = files?.["agent.ts"] ?? "";
  const config = parseLoadedConfig(turn.lastTestAgentOutput);
  const expectation = EXPECTATIONS.find((e) => e.label === label);
  const workflow = kind === "workflow";

  t.check(turn.testAgentRuns.length > 0, "verified (ran test_agent)", "never ran test_agent");
  t.check(built, "endedGreen", last === undefined ? "no run" : last.excerpt);
  t.check(turn.errors.length === 0, "no stream errors", turn.errors.slice(0, 3).join(" | "));
  t.check(
    turn.toolCalls.length < STEP_CAP_HINT,
    `under the step cap (${STEP_CAP_HINT})`,
    `made ${turn.toolCalls.length} tool calls`,
  );
  // Red verifications, whichever tool ran them: an agent whose cheaper checks
  // catch the errors first scores zero repairs while writing the same wrong code.
  t.check(
    turn.redChecks.length === 0,
    "first-try clean (no red verification)",
    turn.redExcerpts.slice(0, 3).join(" | "),
  );

  if (expectation !== undefined) {
    const caps = checkCapabilities(expectation, { config, source });
    t.check(caps.missing.length === 0, "covers the prompt's capabilities", caps.missing.join("/"));
    t.check(
      caps.missingBuiltins.length === 0,
      "declares the named builtins",
      caps.missingBuiltins.join("/"),
    );
    t.check(!caps.tooFewTools, "declares enough tools", `only ${caps.toolCount}`);
  }

  // A workflow project is graded on the workflow-app SHAPE instead of pipeline
  // mode and a live-state client: it has no session, so those are questions
  // about a thing that does not exist here.
  const mode = workflow ? checkWorkflowShape(files) : checkMode(config, source);
  t.check(mode.ok, workflow ? "workflow-app shape" : "pipeline mode", mode.note ?? "");
  if (!workflow) {
    // `checkUi` is the whole UI claim, and a bare "did it write a client.tsx"
    // check is deliberately NOT added beside it: `run.mjs` recorded `builtClient`
    // as INFORMATION and kept it out of its `shippable` verdict, because most
    // starters never ask for one — asserting it failed the math-tutor template
    // for shipping exactly what it is supposed to ship.
    const ui = checkUi(expectation, files);
    t.check(ui.ok, "client UI", ui.note ?? "");
  }
}

const describeStarters = describeEvalTierWhen(
  await studioReachable(ORIGIN),
  `no studio answered at ${ORIGIN}`,
  "Start one with `pnpm dev:aai-server`, or set AAI_EVAL_ORIGIN.",
);

describeStarters("starter eval — studio codegen", () => {
  registerEvalCases(
    STARTER_CASES.map((starter) => ({
      name: starter.label,
      async body(t) {
        const client = createStudioClient(ORIGIN, evalApiKey());
        const project = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const turn = await client.runTurn(project, starter.kind, starter.prompt);
        const files = await client.workspace(project);
        gradeStarter(t, starter.label, starter.kind, turn, files);
      },
    })),
  );
});
