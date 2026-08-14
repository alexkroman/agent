/**
 * The three nodes: plan, execute one step, replan.
 *
 * ```text
 * plan → execute(step 1) → replan ──plan──→ execute(next step) → replan
 *                             └──respond──→ done
 * ```
 *
 * **The loop is driven by the CALLER, not by the graph.** Their notebook runs
 * `plan → execute → replan → execute …` to completion and prints the answer; a
 * phone call cannot go quiet for a minute and a half. So one `work_next_step`
 * tool call is exactly one execute-then-replan turn, the desk says what it
 * found, and the caller decides whether to carry on — which is also what makes
 * `revise_plan` possible, since there is a gap between steps for a human to
 * speak into. The nodes below are the same nodes; the driver is the
 * conversation.
 *
 * **Search is injected** (see `shared.ts`): the executor's search is really the
 * web, so the spec passes its own.
 */

import type { GenerateFn } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai";
import {
  actSchema,
  EXECUTOR_SYSTEM,
  PLANNER_SYSTEM,
  planSchema,
  REPLANNER_SYSTEM,
  stepActionSchema,
} from "./prompts.ts";
import type { PastStep, PlanState, SearchFn } from "./shared.ts";

/** Model turns one step may take, including its final answer. */
export const MAX_STEP_TURNS = 3;
/** Searches one step may run. The budget is the mechanism: a step told to
 *  "search until sure" is a step whose cost nobody can quote. */
export const MAX_STEP_SEARCHES = 2;

/** Their `plan_step`. */
export async function planNode(generate: GenerateFn, objective: string): Promise<string[]> {
  const { object } = await generate({
    system: PLANNER_SYSTEM,
    prompt: `Objective: ${objective}`,
    schema: planSchema,
  });
  return object.steps;
}

export interface StepOutcome {
  result: string;
  searches: string[];
}

function describeHits(hits: { title: string; url: string }[]): string {
  if (hits.length === 0) return "No results.";
  return hits.map((hit) => `- ${hit.title} (${hit.url})`).join("\n");
}

/** Completed steps as the executor and the replanner both read them. */
function historyOf(pastSteps: PastStep[]): string {
  if (pastSteps.length === 0) return "Nothing done yet.";
  return pastSteps
    .map((past, index) => `${index + 1}. ${past.step}\n   → ${past.result}`)
    .join("\n");
}

/**
 * Their `execute_step` — a ReAct agent with a search tool, distilled to a
 * bounded search/answer loop.
 */
export async function executeStep(
  generate: GenerateFn,
  search: SearchFn,
  objective: string,
  step: string,
  pastSteps: PastStep[],
): Promise<StepOutcome> {
  const searches: string[] = [];
  const notes: string[] = [];

  for (let turn = 0; turn < MAX_STEP_TURNS; turn++) {
    const exhausted = searches.length >= MAX_STEP_SEARCHES;
    const { object } = await generate({
      system: EXECUTOR_SYSTEM,
      prompt: [
        `Objective: ${objective}`,
        `Steps already done:\n${historyOf(pastSteps)}`,
        `The step you are doing now: ${step}`,
        notes.length > 0 ? `What your searches returned:\n${notes.join("\n\n")}` : "",
        exhausted ? "You have used your search budget — answer with what you have." : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      schema: stepActionSchema,
    });

    if (object.action === "search" && object.query && !exhausted) {
      searches.push(object.query);
      try {
        const hits = await search(object.query);
        notes.push(`Search "${object.query}":\n${describeHits(hits)}`);
      } catch (err: unknown) {
        // A failed search goes back to the model, not only to a log: told
        // nothing, it reads silence as "no such pages exist" and burns the rest
        // of the budget re-asking the same question.
        notes.push(`Search "${object.query}" failed: ${errorMessage(err)}`);
      }
      continue;
    }

    if (object.answer) return { result: object.answer, searches };
    // An `answer` action with no answer is a malformed turn, not a verdict —
    // let the loop try again rather than recording an empty step result.
    notes.push("Your last reply carried no answer. Answer the step.");
  }

  return {
    result: "This step could not be settled within its budget.",
    searches,
  };
}

/** Their `Act`, once it has been checked for the halves a provider can drop. */
export type ActDecision = { kind: "respond"; response: string } | { kind: "plan"; steps: string[] };

/**
 * Read an `Act` the way a caller needs it read.
 *
 * A structured-output model can return `kind: "respond"` with no `response`, or
 * `kind: "plan"` with an empty list. Neither is a reason to loop: the fallback
 * is always an ANSWER, because the failure mode that matters on a phone call is
 * a desk that never stops working.
 */
export function normalizeAct(
  // `| undefined` on both optionals is what `exactOptionalPropertyTypes`
  // requires of a parameter that receives a validated schema output: the
  // schema's own type says "absent", and a caller destructuring one may well
  // pass an explicit `undefined`.
  object: { kind: "respond" | "plan"; response?: string | undefined; steps?: string[] | undefined },
  fallback: string,
): ActDecision {
  const steps = object.steps?.filter((step) => step.trim().length > 0) ?? [];
  if (object.kind === "plan" && steps.length > 0) return { kind: "plan", steps };
  if (object.response && object.response.trim().length > 0) {
    return { kind: "respond", response: object.response.trim() };
  }
  if (steps.length > 0) return { kind: "plan", steps };
  return { kind: "respond", response: fallback };
}

/** Their `replan_step`. `instruction` is the caller interrupting; theirs has no
 *  equivalent, because a notebook has nobody to interrupt it. */
export async function replanNode(
  generate: GenerateFn,
  state: Pick<PlanState, "objective" | "plan" | "pastSteps">,
  options: { system?: string; instruction?: string } = {},
): Promise<ActDecision> {
  const { object } = await generate({
    system: options.system ?? REPLANNER_SYSTEM,
    prompt: [
      `Objective: ${state.objective ?? "(none stated)"}`,
      `Steps done:\n${historyOf(state.pastSteps)}`,
      `Steps still planned:\n${state.plan.length > 0 ? state.plan.map((step) => `- ${step}`).join("\n") : "(none)"}`,
      options.instruction ? `The caller has just said: ${options.instruction}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    schema: actSchema,
  });

  return normalizeAct(
    object,
    // The last step's result is the honest fallback answer: it is the most
    // recent true thing the desk knows.
    state.pastSteps.at(-1)?.result ?? "There is nothing left to do on that.",
  );
}
