import { planFlow, planSlot, stageLabel } from "../shared.ts";

/**
 * Where the plan is. Read-only, so plain slot semantics — a synchronous read
 * cannot interleave with anything.
 *
 * **It is a `planSlot.tool` and not a `tool()` that opens with
 * `planSlot.get(ctx)`.** The declaration is what makes "does this write?"
 * visible: the body is handed the plan already frozen, so a line that tried to
 * mutate it stops compiling rather than throwing on the first live call. That is
 * the whole difference between this and its mutating siblings, and it should be
 * readable from the first line rather than from the absence of an `update`.
 *
 * **Legal in every state, which is why it is not a `planFlow.tool`**, and it is
 * the one tool that reports the flow's own POSITION: `stage` and `next` come
 * from the machine rather than from a second reading of the plan's fields, so
 * "no plan yet" is the same fact here as the refusal `work_next_step` would
 * give. It used to derive that from `!plan.objective`, which was a third copy of
 * the same question.
 */
export default planSlot.tool({
  description:
    "Say where the plan has got to: what is done, what is left, and the answer " +
    "if there is one. Use it when the caller asks, or to pick a call back up.",
  execute(_args, plan, ctx) {
    const at = planFlow.position(ctx);
    return {
      stage: at.state,
      reads: stageLabel(at),
      next: at.instruction,
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
