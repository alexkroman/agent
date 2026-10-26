import { errorMessage, toolFailure, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { replanNode } from "../procedure.ts";
import { REVISE_SYSTEM } from "../prompts.ts";
import { planFlow, planSlot } from "../shared.ts";

/**
 * The replanner, driven by the caller instead of by a step result.
 *
 * There is no counterpart in the notebook, and the gap is the interesting part:
 * their replanner only ever reacts to what a step returned, because a notebook
 * has nobody to interrupt it. Half of what a person does on a planning call is
 * change their mind, and the node that already exists to rewrite a plan from
 * new information is the right one to hand that to.
 *
 * **Legal in `working` AND `answered`, which is the whole point of it.** A
 * finished plan is exactly what a caller most often wants changed, so this is
 * the one tool that reopens one — `REOPENED` takes the flow back to `working`,
 * and the body's clearing of `plan.response` is the same decision at the data
 * level. The event rides on the result as `next`, which `sendFrom` names.
 */
export default planSlot.updateTool({
  description:
    "Rewrite the remaining plan because the caller changed what they want. " +
    "Pass their instruction as they said it. Completed steps are never redone.",
  ui: { icon: "\u{270F}", label: "Revising the plan" },
  inputSchema: z.object({
    instruction: z
      .string()
      .max(400)
      .describe("What the caller now wants changed, in their own words"),
  }),
  dialog: planFlow,
  when: ["working", "answered"],
  sendFrom: "next",
  async prepare({ instruction }, plan, ctx) {
    try {
      return await replanNode(ctx.generate, plan, { system: REVISE_SYSTEM, instruction });
    } catch (err: unknown) {
      return toolFailure(`The plan could not be revised: ${errorMessage(err)}`);
    }
  },
  execute({ instruction }, plan, act) {
    plan.revisions.push(`Caller: ${instruction}`);

    if (act.kind === "respond") {
      plan.plan = [];
      plan.response = act.response;
      return withInstruction(
        { finished: true, response: act.response, next: "ANSWERED" as const },
        "Nothing is left to do.",
      );
    }

    plan.plan = act.steps;
    // A revision reopens a plan that had already answered: the caller has
    // moved the goalposts, so the old answer is no longer the answer.
    plan.response = null;
    return withInstruction(
      { finished: false, remaining: act.steps, next: "REOPENED" as const },
      "Read the revised steps back and ask if that is right.",
    );
  },
});
