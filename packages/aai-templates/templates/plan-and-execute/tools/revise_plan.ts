import { errorMessage, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { replanNode } from "../graph.ts";
import { REVISE_SYSTEM } from "../prompts.ts";
import { noteRevision, planFlow, planSlot } from "../shared.ts";

/**
 * The replanner, driven by the caller instead of by a step result.
 *
 * There is no counterpart in the notebook, and the gap is the interesting part:
 * their replanner only ever reacts to what a step returned, because a notebook
 * has nobody to interrupt it. Half of what a person does on a planning call is
 * change their mind, and the node that already exists to rewrite a plan from
 * new information is the right one to hand that to.
 *
 * The await-then-mutate shape is `start_plan`'s, for the reason it gives — and
 * note the READ before the await is `planSlot.get`, which the replanner only
 * needs to look at.
 *
 * **Legal in `working` AND `answered`, which is the whole point of it.** A
 * finished plan is exactly what a caller most often wants changed, so this is
 * the one tool that reopens one — `REOPENED` takes the flow back to `working`,
 * and the body's clearing of `plan.response` is the same decision at the data
 * level. Its `!objective` guard is gone: `when` is that check now.
 */
export default planFlow.tool({
  description:
    "Rewrite the remaining plan because the caller changed what they want. " +
    "Pass their instruction as they said it. Completed steps are never redone.",
  inputSchema: z.object({
    instruction: z
      .string()
      .max(400)
      .describe("What the caller now wants changed, in their own words"),
  }),
  when: ["working", "answered"],
  async execute(args, ctx) {
    try {
      const act = await replanNode(ctx.generate, planSlot.get(ctx), {
        system: REVISE_SYSTEM,
        instruction: args.instruction,
      });
      return planSlot.update(ctx, (plan) => {
        noteRevision(plan, `Caller: ${args.instruction}`);

        if (act.kind === "respond") {
          plan.plan = [];
          plan.response = act.response;
          return { finished: true, response: act.response, message: "Nothing is left to do." };
        }

        plan.plan = act.steps;
        // A revision reopens a plan that had already answered: the caller has
        // moved the goalposts, so the old answer is no longer the answer.
        plan.response = null;
        return {
          finished: false,
          remaining: act.steps,
          message: "Read the revised steps back and ask if that is right.",
        };
      });
    } catch (err: unknown) {
      return toolFailure(`The plan could not be revised: ${errorMessage(err)}`);
    }
  },
});
