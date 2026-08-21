import { tool } from "@alexkroman1/aai";
import { planFlow, planSlot, stageLabel } from "../shared.ts";

/**
 * Where the plan is. Read-only, so plain `tool` semantics — a synchronous read
 * cannot interleave with anything.
 *
 * **Legal in every state, which is why it is not a `planFlow.tool`**, and it is
 * the one tool that reports the flow's own POSITION: `stage` and `next` come
 * from the machine rather than from a second reading of the plan's fields, so
 * "no plan yet" is the same fact here as the refusal `work_next_step` would
 * give. It used to derive that from `!plan.objective`, which was a third copy of
 * the same question.
 */
export default tool({
  description:
    "Say where the plan has got to: what is done, what is left, and the answer " +
    "if there is one. Use it when the caller asks, or to pick a call back up.",
  execute(_args, ctx) {
    const at = planFlow.position(ctx);
    const plan = planSlot.get(ctx);
    return {
      stage: at.state,
      reads: stageLabel(at),
      next: at.instruction,
      objective: plan.objective,
      done: plan.pastSteps.map((past) => ({ step: past.step, result: past.result })),
      remaining: plan.plan,
      response: plan.response,
    };
  },
});
