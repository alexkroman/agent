import { planFlow, planSlot, stageLabel } from "../shared.ts";

/**
 * Where the plan is. Read-only, so plain slot semantics — a synchronous read
 * cannot interleave with anything.
 *
 * **Legal in every state** (no `when`), and gated on the flow all the same so
 * the envelope carries the flow's own POSITION: `state` and `instruction` come
 * from the machine rather than from a second reading of the plan's fields, so
 * "no plan yet" is the same fact here as the refusal `work_next_step` would
 * give. It used to derive that from `!plan.objective`, which was a third copy
 * of the same question.
 */
export default planSlot.tool({
  description:
    "Say where the plan has got to: what is done, what is left, and the answer " +
    "if there is one. Use it when the caller asks, or to pick a call back up.",
  ui: { icon: "\u{2139}", label: "Checking the plan" },
  dialog: planFlow,
  execute(_args, plan, ctx) {
    return {
      reads: stageLabel(planFlow.position(ctx)),
      objective: plan.objective,
      done: plan.pastSteps.map((past) => ({
        step: past.step,
        result: past.result,
        settled: past.settled,
      })),
      remaining: plan.plan,
      response: plan.response,
    };
  },
});
