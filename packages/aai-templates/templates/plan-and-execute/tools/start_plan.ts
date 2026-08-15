import { errorMessage, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { planNode } from "../graph.ts";
import { noteRevision, planSlot } from "../shared.ts";

/**
 * Their `plan_step`, as the call's opening move.
 *
 * **The await comes FIRST, then the mutation.** `slot.update` is synchronous —
 * its window cannot span an await, which is what makes a read-modify-write
 * atomic without a lock — so a body that has to call a model does that outside
 * it and mutates once the answer is in hand. The hazard the old serialized
 * version guarded against is unchanged (the LLM loop runs a step's tool calls
 * concurrently, so two plans started at once must not interleave); what changed
 * is that the window is now too short to interleave IN.
 */
export default tool({
  description:
    "Draft a plan for what the caller wants to get done. Use this once you " +
    "understand the objective. Read the steps back to them afterwards.",
  inputSchema: z.object({
    objective: z
      .string()
      .max(400)
      .describe("What the caller wants, stated as one goal in their own terms"),
  }),
  async execute(args, ctx) {
    let steps: string[];
    try {
      steps = await planNode(ctx.generate, args.objective);
    } catch (err: unknown) {
      return toolFailure(`The planner failed: ${errorMessage(err)}`);
    }

    return planSlot.update(ctx, (plan) => {
      plan.objective = args.objective;
      plan.plan = steps;
      plan.pastSteps = [];
      plan.response = null;
      noteRevision(plan, `Planned ${steps.length} step(s) for: ${args.objective}`);

      return {
        objective: args.objective,
        steps,
        message:
          "Read the plan back in one breath, then ask if they want you to start. " +
          "Work it one step at a time with work_next_step.",
      };
    });
  },
});
