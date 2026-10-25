import { errorMessage, toolFailure, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { planNode } from "../procedure.ts";
import { planFlow, planSlot } from "../shared.ts";

/**
 * Their `plan_step`, as the call's opening move.
 *
 * `prepare` is the model call and `execute` the synchronous window it feeds —
 * two plans started at once cannot interleave inside it. The dialog's `send`
 * then moves the flow: `work_next_step` gates on `working`, and a plan written
 * to the slot while the flow still said `idle` would be refused by its own next
 * tool call. No `when`, because `PLANNED` is accepted in all three states —
 * re-planning from scratch is always legal.
 */
export default planSlot.updateTool({
  description:
    "Draft a plan for what the caller wants to get done. Use this once you " +
    "understand the objective. Read the steps back to them afterwards.",
  ui: { icon: "\u{1F5C2}", label: "Drafting the plan" },
  inputSchema: z.object({
    objective: z
      .string()
      .max(400)
      .describe("What the caller wants, stated as one goal in their own terms"),
  }),
  dialog: planFlow,
  send: { type: "PLANNED" },
  async prepare({ objective }, _plan, ctx) {
    try {
      return await planNode(ctx.generate, objective);
    } catch (err: unknown) {
      return toolFailure(`The planner failed: ${errorMessage(err)}`);
    }
  },
  execute({ objective }, plan, steps) {
    plan.objective = objective;
    plan.plan = steps;
    plan.pastSteps = [];
    plan.response = null;
    plan.revisions.push(`Planned ${steps.length} step(s) for: ${objective}`);
    return withInstruction(
      { objective, steps },
      "Read the plan back in one breath, then ask if they want you to start. " +
        "Work it one step at a time with work_next_step.",
    );
  },
});
