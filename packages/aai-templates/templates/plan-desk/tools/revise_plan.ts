import { errorMessage, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { replanNode } from "../graph.ts";
import { REVISE_SYSTEM } from "../prompts.ts";
import { noteRevision, planSlot } from "../shared.ts";

/**
 * The replanner, driven by the caller instead of by a step result.
 *
 * There is no counterpart in the notebook, and the gap is the interesting part:
 * their replanner only ever reacts to what a step returned, because a notebook
 * has nobody to interrupt it. Half of what a person does on a planning call is
 * change their mind, and the node that already exists to rewrite a plan from
 * new information is the right one to hand that to.
 */
export const revisePlan = planSlot.updateTool({
  description:
    "Rewrite the remaining plan because the caller changed what they want. " +
    "Pass their instruction as they said it. Completed steps are never redone.",
  inputSchema: z.object({
    instruction: z
      .string()
      .max(400)
      .describe("What the caller now wants changed, in their own words"),
  }),
  async execute(args, plan, ctx) {
    if (!plan.objective) return toolFailure("There is no plan to revise — use start_plan first.");

    try {
      const act = await replanNode(ctx.generate, plan, {
        system: REVISE_SYSTEM,
        instruction: args.instruction,
      });
      noteRevision(plan, `Caller: ${args.instruction}`);

      if (act.kind === "respond") {
        plan.plan = [];
        plan.response = act.response;
        return { done: true, response: act.response, message: "Nothing is left to do." };
      }

      plan.plan = act.steps;
      // A revision reopens a plan that had already answered: the caller has
      // moved the goalposts, so the old answer is no longer the answer.
      plan.response = null;
      return {
        done: false,
        remaining: act.steps,
        message: "Read the revised steps back and ask if that is right.",
      };
    } catch (err: unknown) {
      return toolFailure(`The plan could not be revised: ${errorMessage(err)}`);
    }
  },
});
