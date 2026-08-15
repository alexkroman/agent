import { errorMessage, isToolFailure, tool, toolFailure } from "@alexkroman1/aai";
import { executeStep, replanNode } from "../graph.ts";
import { liveSearch, noteRevision, type PastStep, planSlot } from "../shared.ts";

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
 * **The step is CLAIMED before the model call, not after**, and that is what
 * makes two concurrent calls safe. The LLM loop runs a step's tool calls
 * concurrently: under a plain read-then-await both calls would read step one,
 * both do it, and both record it. Taking the step off the head of the plan
 * inside a synchronous `update` is atomic, so the second call claims step two —
 * strictly better than the lock this replaced, which serialized two model calls
 * behind each other to get the same guarantee. A step whose work then FAILS is
 * put back, because a failed model call is worth retrying and a silently dropped
 * step leaves the caller with a plan that skipped something.
 */
export default tool({
  description:
    "Do the next step of the plan and report what it found. Call this once per " +
    "step — never in a loop. Say a short 'let me look into that' first, since " +
    "the step may take a few seconds.",
  async execute(_args, ctx) {
    // The whole read-and-claim, in one window nothing can interleave with.
    const claimed = planSlot.update(ctx, (plan) => {
      if (!plan.objective) return toolFailure("There is no plan yet — use start_plan first.");
      if (plan.response) {
        return {
          done: true as const,
          response: plan.response,
          message: "The plan is already finished.",
        };
      }
      const step = plan.plan.shift();
      if (!step) {
        return {
          done: true as const,
          message: "No steps are left. Ask the caller what they want next.",
        };
      }
      return { step, objective: plan.objective, pastSteps: [...plan.pastSteps] as PastStep[] };
    });
    if (isToolFailure(claimed) || "done" in claimed) return claimed;
    const { step, objective, pastSteps } = claimed;

    try {
      const outcome = await executeStep(ctx.generate, liveSearch, objective, step, pastSteps);
      planSlot.update(ctx, (plan) => {
        plan.pastSteps.push({ step, result: outcome.result, searches: outcome.searches });
      });

      // Their `replan_step`: the plan after a step is whatever still needs
      // doing, decided from the result rather than from what was planned before
      // anyone knew it.
      const act = await replanNode(ctx.generate, planSlot.get(ctx));
      return planSlot.update(ctx, (plan) => {
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
      });
    } catch (err: unknown) {
      // Put the claimed step back at the head, where a retry will find it.
      planSlot.update(ctx, (plan) => {
        plan.plan.unshift(step);
      });
      return toolFailure(`That step could not be worked: ${errorMessage(err)}`);
    }
  },
});
