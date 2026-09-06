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
 * **The executor is a SUBAGENT** — `subagent()` plus `ctx.delegate`, rather
 * than the bounded search/answer loop this file used to hand-roll around
 * `ctx.generate`. Theirs is a ReAct agent, so this is the more faithful port as
 * well as the shorter one: a tool call is a validated action, `maxSteps` is the
 * budget, the last step is spent with tools withheld so a capped run answers,
 * and a tool that throws comes back as a result the model can recover from.
 * Fifty lines of turn counter, action schema and budget prose went with it.
 *
 * The two seams that existed for TESTABILITY went with it too — the executor
 * took a `generate` and a `search` so a spec could drive it offline. There is
 * one seam now and it is the SDK's: `stubDelegate` routes by subagent name.
 * `planNode` and `replanNode` still take a `GenerateFn`, being one-shot calls
 * rather than loops.
 */

import type { DelegateFn, GenerateFn } from "@alexkroman1/aai";
import { type DeepReadonly, isRecord, subagent } from "@alexkroman1/aai";
import {
  actSchema,
  EXECUTOR_OUTPUT,
  EXECUTOR_SYSTEM,
  PLANNER_SYSTEM,
  planSchema,
  REPLANNER_SYSTEM,
} from "./prompts.ts";
import type { FrozenPlanState, PastStep } from "./shared.ts";
import { readTool, searchTool } from "./shared.ts";

/** Their `plan_step`. */
export async function planNode(generate: GenerateFn, objective: string): Promise<string[]> {
  const { object } = await generate({
    system: PLANNER_SYSTEM,
    prompt: `Objective: ${objective}`,
    schema: planSchema,
  });
  return object.steps;
}

/**
 * Tool-calling steps the executor may take before it must answer.
 *
 * The budget is the mechanism, not the prompt: a step told to "search until
 * sure" is a step whose cost nobody can quote. Past it the executor is asked for
 * its answer with its tools WITHHELD, so a capped run still answers the step
 * rather than stopping mid-chain — which the hand-rolled loop had to request in
 * the prompt ("you have used your search budget") and could not enforce.
 *
 * There used to be a second cap on SEARCHES inside these turns. It is gone
 * because it stopped meaning anything: a turn is a tool call now, so the two
 * budgets counted the same thing.
 */
export const MAX_STEP_TURNS = 3;

/**
 * Their `execute_step` — a ReAct agent with a search tool.
 *
 * **It IS one now, rather than a loop that stands in for one.** This was fifty
 * lines of turn counter, action schema, "you have used your search budget"
 * sentence, a branch for the turn where the model named an action and filled in
 * no field, and a failed search pushed back as an observation. Every one of
 * those is what a subagent already is — a tool call is a validated action, the
 * step budget is the loop's, the last step is forced to answer, and a tool that
 * throws comes back to the model as a result it can recover from.
 *
 * This file is 13 code lines lighter and the TEMPLATE is larger, which is worth
 * being honest about: `shared.ts` gained `search` and `read` as real tools, and
 * `read` is a capability the loop never had at all.
 *
 * Its TOOLS are this template's own rather than the `web_search` /
 * `visit_webpage` builtins, and that is deliberate: they are the worked example
 * of calling `@alexkroman1/aai/tools` from an agent's own code, and a subagent
 * takes an ordinary `ToolDef` — so the example survives the loop it used to live
 * in, one layer down. `read` is NEW, and it closes a gap the loop had left open:
 * the prompt said "search once, read what comes back" while the only actions
 * were search and answer, so the executor answered from lists of titles.
 */
export const executor = subagent({
  name: "executor",
  systemPrompt: EXECUTOR_SYSTEM,
  expectedOutput: EXECUTOR_OUTPUT,
  tools: { search: searchTool, read: readTool },
  maxSteps: MAX_STEP_TURNS,
});

export interface StepOutcome {
  result: string;
  searches: string[];
}

/** Completed steps as the executor and the replanner both read them. */
function historyOf(pastSteps: readonly DeepReadonly<PastStep>[]): string {
  if (pastSteps.length === 0) return "Nothing done yet.";
  return pastSteps
    .map((past, index) => `${index + 1}. ${past.step}\n   → ${past.result}`)
    .join("\n");
}

/**
 * Do one step of the plan, on the executor.
 *
 * Takes the DELEGATE rather than a `generate` and a `search`: the two seams the
 * old body needed for testability are one seam now, and it is the SDK's —
 * `stubDelegate` routes by subagent name.
 */
export async function executeStep(
  delegate: DelegateFn,
  objective: string,
  step: string,
  pastSteps: readonly DeepReadonly<PastStep>[],
): Promise<StepOutcome> {
  const result = await delegate(executor, {
    task: step,
    // The executor has not heard the call and cannot see the plan, so what it
    // needs to do this step in context rides here — the objective it serves and
    // what the earlier steps already established.
    context: [`Objective: ${objective}`, `Steps already done:\n${historyOf(pastSteps)}`].join(
      "\n\n",
    ),
  });
  return {
    result: result.text,
    // What the wait bought, read off the calls the run made — the desk renders
    // these, and `toolCalls` is the only honest source for them: a search's
    // RESULTS stayed inside the executor's context, which is the point.
    searches: result.toolCalls.flatMap((call) =>
      call.name === "search" ? [queryOf(call.input)] : [],
    ),
  };
}

/** The query one recorded `search` call named. */
function queryOf(input: unknown): string {
  return isRecord(input) && typeof input.query === "string" ? input.query : "(unnamed search)";
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
  state: Pick<FrozenPlanState, "objective" | "plan" | "pastSteps">,
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
