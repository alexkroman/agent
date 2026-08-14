import { planSlot } from "../shared.ts";

/**
 * Where the plan is. Read-only, so plain `tool` semantics — a synchronous
 * read cannot interleave with anything.
 */
export const planStatus = planSlot.tool({
  description:
    "Say where the plan has got to: what is done, what is left, and the answer " +
    "if there is one. Use it when the caller asks, or to pick a call back up.",
  execute(_args, plan) {
    if (!plan.objective) return { message: "No plan yet. Ask what they want to get done." };
    return {
      objective: plan.objective,
      done: plan.pastSteps.map((past) => ({ step: past.step, result: past.result })),
      remaining: plan.plan,
      response: plan.response,
    };
  },
});
