import { errorMessage, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { planNode } from "../graph.ts";
import { noteRevision, planSlot } from "../shared.ts";

/**
 * Their `plan_step`, as the call's opening move.
 *
 * `updateTool` rather than `tool`: the body awaits a model call and then
 * mutates, and the LLM loop runs a step's tool calls concurrently — two plans
 * started at once would each write over the other's. Serializing per session is
 * the whole reason the method exists.
 */
export const startPlan = planSlot.updateTool({
  description:
    "Draft a plan for what the caller wants to get done. Use this once you " +
    "understand the objective. Read the steps back to them afterwards.",
  inputSchema: z.object({
    objective: z
      .string()
      .max(400)
      .describe("What the caller wants, stated as one goal in their own terms"),
  }),
  async execute(args, plan, ctx) {
    let steps: string[];
    try {
      steps = await planNode(ctx.generate, args.objective);
    } catch (err: unknown) {
      return toolFailure(`The planner failed: ${errorMessage(err)}`);
    }

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
  },
});
