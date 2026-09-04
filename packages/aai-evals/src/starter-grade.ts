// Copyright 2026 the AAI authors. MIT license.
/**
 * Grading one studio turn: which checks exist, and what each is called.
 *
 * A module rather than a function inside `starter.eval.test.ts`, because that
 * file is an `*.eval.test.ts` — excluded by this package's `vitest.config.ts`,
 * so nothing in the unit run and nothing in any coverage report reached it.
 * Every function this one CALLS (`checkMode`, `checkUi`, `checkWorkflowShape`,
 * `parseLoadedConfig`, `checkCapabilities`) was unit-tested next door while the
 * thing that decides which of them run, and under what label, was exercised
 * only by a run needing a live key and a live studio.
 *
 * The labels are why that matters: they are the keys {@link EvalReport.unstable}
 * reports and the strings `AAI_EVAL_ONLY` matches, so renaming one silently
 * resets the flip history with nothing red. It is also verbatim the mistake this
 * package's guide records fixing when it moved `expectations.mjs` in — "a grader
 * whose eval-only half was in no coverage report at all" — recurring one level
 * up.
 *
 * @module
 */

import { evalStepCapHint } from "./_env.ts";
import type { EvalRecorder } from "./runner.ts";
import {
  checkCapabilities,
  checkMode,
  checkUi,
  checkWorkflowShape,
  EXPECTATIONS,
  type Expectation,
  parseLoadedConfig,
} from "./starter-expectations.ts";
import type { StudioTurn } from "./studio-target.ts";

/** The expectation a starter label names, if one is declared for it. */
const BY_LABEL: ReadonlyMap<string, Expectation> = new Map(EXPECTATIONS.map((e) => [e.label, e]));

/** One starter turn, as {@link gradeStarter} reads it. */
export type StarterRun = {
  /** The starter's label — the key an expectation is looked up by. */
  readonly label: string;
  /** The project KIND that selected the coding-agent prompt. */
  readonly kind: string;
  readonly turn: StudioTurn;
  /** The synced workspace, or undefined when the sync never landed. */
  readonly files: Record<string, string> | undefined;
};

/**
 * Grade one turn, recording every check.
 *
 * The failure taxonomy is the label set, so a report names which of the three
 * problems a case hit — never verified, verified-and-broken, out of steps —
 * rather than reporting one "shippable" bit.
 */
export function gradeStarter(t: EvalRecorder, { label, kind, turn, files }: StarterRun): void {
  const last = turn.testAgentRuns.at(-1);
  const built = last !== undefined && !last.buildFailed && !last.testsFailed;
  const source = files?.["agent.ts"] ?? "";
  const config = parseLoadedConfig(turn.lastTestAgentOutput);
  const expectation = BY_LABEL.get(label);
  const workflow = kind === "workflow";
  const stepCap = evalStepCapHint();

  t.check(turn.testAgentRuns.length > 0, "verified (ran test_agent)", "never ran test_agent");
  t.check(built, "endedGreen", last === undefined ? "no run" : last.excerpt);
  t.check(turn.errors.length === 0, "no stream errors", turn.errors.slice(0, 3).join(" | "));
  t.check(
    turn.toolCalls.length < stepCap,
    `under the step cap (${stepCap})`,
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
  const mode = workflow ? checkWorkflowShape(files) : checkMode(config);
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
