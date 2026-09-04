// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio starter eval, on the shared runner.
 *
 * This is `scripts/starter-eval/run.mjs`'s case loop, verdict and reporter —
 * `run.mjs` (485 lines), `report.mjs` (175) and `regrade.mjs` (85) — replaced by
 * the tier's own machinery. What did NOT move is the grading: those checks read
 * generated SOURCE rather than behaviour, which is a different job, so they were
 * kept when the runner was not. They are `./starter-expectations.ts`, which this
 * suite imports; they were `scripts/starter-eval/expectations.mjs` for as long
 * as that directory had anything left in it.
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

import path from "node:path";
import { STARTERS } from "aai-studio-client/starters";
import {
  describeEvalTier,
  describeEvalTierWhen,
  evalApiKey,
  evalContracts,
  evalKeyEnv,
  evalOrigin,
} from "./_gate.ts";
import { evalOnlySelects, registerEvalCases } from "./_register.ts";
import { gradeStarter } from "./starter-grade.ts";
import { createStudioClient } from "./studio-target.ts";
import {
  CONTRACT_SCRATCH_ROOT,
  runTemplateContract,
  spawnVitest,
  TEMPLATES_DIR,
} from "./template-contract.ts";

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
 * Probed only when this file has a case to run.
 *
 * `AAI_EVAL_ONLY` is one variable across the whole tier, so selecting a level-1
 * behaviour case used to make THIS file pay a 3-second HTTP probe and then
 * announce `[skipped: no studio answered…]` about a run nobody asked it for.
 * The selection is `_register.ts`'s, imported rather than restated, so the
 * probe's precondition and the registration's cannot drift.
 */
const SELECTED = STARTER_CASES.filter((starter) => evalOnlySelects(starter.label));

const describeStarters =
  SELECTED.length === 0
    ? describeEvalTier
    : describeEvalTierWhen(
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
        try {
          const turn = await client.runTurn(project, starter.kind, starter.prompt);
          const files = await client.workspace(project);
          gradeStarter(t, { label: starter.label, kind: starter.kind, turn, files });
          // The BEHAVIOUR half, opt-in — see `evalContracts` for the cost
          // argument and `template-contract.ts` for why the template's own eval
          // is the contract. A starter naming no template, or naming one that
          // ships no eval, records NOTHING rather than a passing check: a check
          // that cannot fail is one more line saying "green" for no reason.
          if (evalContracts()) {
            const contract = await runTemplateContract({
              files: files ?? {},
              prompt: starter.prompt,
              templatesDir: TEMPLATES_DIR,
              scratchDir: path.join(CONTRACT_SCRATCH_ROOT, project),
              run: spawnVitest(evalKeyEnv()),
            });
            if (contract.outcome !== "skipped") {
              t.check(
                contract.outcome === "passed",
                "passes the template's behaviour contract",
                contract.note,
              );
            }
          }
        } finally {
          // A case REMOVES what it wrote. This target drives a REAL studio, so
          // the project, its workspace and its `*-preview` agent are durable —
          // and against a dev server on the local Supabase stack they outlive
          // the run and every run after it. What that costs is not just a
          // sidebar full of dead `eval-*` projects: the dev server keeps
          // brokering their preview agents, so each one becomes a recurring 503
          // in the log that names no test, which is what makes left-behind state
          // worse than noisy state.
          //
          // In `finally` rather than after the grade: a case that THREW is the
          // one most likely to have created a project, and grading is what
          // throws.
          await client.deleteProject(project);
        }
      },
    })),
  );
});
