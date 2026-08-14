import { errorMessage, toolFailure } from "@alexkroman1/aai";
import { executeStep, replanNode } from "../graph.ts";
import { liveSearch, noteRevision, planSlot } from "../shared.ts";

/**
 * One turn of their execute→replan loop: do the head step, then let the
 * replanner decide whether the objective is met.
 *
 * **One tool call is one step, deliberately.** Running the loop to completion
 * here would be closer to their notebook and wrong for a phone: a caller cannot
 * hold a silent line while four steps and four searches go by, and there would
 * be no gap for them to change their mind in. The desk reports after each step
 * and the caller says whether to carry on — which is what makes `revise_plan`
 * reachable at all.
 *
 * `updateTool` for the reason `start_plan` gives, and here it is load-bearing:
 * two concurrent calls under `tool` would both read step one, both do it, and
 * both record it. Serialized, the second call sees the first step already done
 * and takes the next.
 */
export const workNextStep = planSlot.updateTool({
  description:
    "Do the next step of the plan and report what it found. Call this once per " +
    "step — never in a loop. Say a short 'let me look into that' first, since " +
    "the step may take a few seconds.",
  async execute(_args, plan, ctx) {
    if (!plan.objective) return toolFailure("There is no plan yet — use start_plan first.");
    if (plan.response) {
      return { done: true, response: plan.response, message: "The plan is already finished." };
    }
    const step = plan.plan[0];
    if (!step) {
      return { done: true, message: "No steps are left. Ask the caller what they want next." };
    }

    try {
      const outcome = await executeStep(
        ctx.generate,
        liveSearch,
        plan.objective,
        step,
        plan.pastSteps,
      );
      plan.plan.shift();
      plan.pastSteps.push({ step, result: outcome.result, searches: outcome.searches });

      // Their `replan_step`: the plan after a step is whatever still needs
      // doing, decided from the result rather than from what was planned before
      // anyone knew it.
      const act = await replanNode(ctx.generate, plan);
      if (act.kind === "respond") {
        plan.response = act.response;
        plan.plan = [];
        noteRevision(plan, `Finished after ${plan.pastSteps.length} step(s)`);
        return {
          done: true,
          step,
          result: outcome.result,
          searches: outcome.searches,
          response: act.response,
          message: "The plan is done — give the caller the answer.",
        };
      }

      const changed = act.steps.join("|") !== plan.plan.join("|");
      plan.plan = act.steps;
      if (changed) noteRevision(plan, `Replanned to ${act.steps.length} step(s) after: ${step}`);
      return {
        done: false,
        step,
        result: outcome.result,
        searches: outcome.searches,
        remaining: act.steps,
        message: "Report what this step found, then ask whether to carry on.",
      };
    } catch (err: unknown) {
      // The step is left in the plan: a failed model call is worth retrying,
      // and silently dropping the step would leave the caller with a plan that
      // skipped something.
      return toolFailure(`That step could not be worked: ${errorMessage(err)}`);
    }
  },
});
