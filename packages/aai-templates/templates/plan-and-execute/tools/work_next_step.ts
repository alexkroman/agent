import { errorMessage, type ToolFailure, toolFailure } from "@alexkroman1/aai";
import { executeStep, replanNode } from "../procedure.ts";
import {
  liveSearch,
  noteRevision,
  type PastStep,
  planFlow,
  planSlot,
  recordStep,
} from "../shared.ts";

/**
 * What the claim window decided, as a DISCRIMINATED union.
 *
 * The three arms used to be told apart by `"done" in claimed`, which stopped
 * working once the outcome had a declared type: union normalization gives every
 * arm the other arms' keys as `?: never`, and `in` cannot rule out a key that is
 * optional-never. A `kind` tag is both narrower and easier to read.
 */
type Claim =
  | { kind: "failed"; failure: ToolFailure }
  | { kind: "dry" }
  | { kind: "step"; step: string; objective: string; pastSteps: PastStep[] };

/**
 * One turn of their execute→replan loop: do the head step, then let the
 * replanner decide whether the objective is met.
 *
 * **One tool call is one step, deliberately.** Running the loop to completion
 * here would be closer to their notebook and wrong for a phone: a caller cannot
 * hold a silent line while four steps and four searches go by, and there would
 * be no gap for them to change their mind in. The desk reports after each step
 * and the caller says whether to carry on — which is what makes `revise_plan`
 * reachable at all.
 *
 * **The step is CLAIMED before the model call, not after**, and that is what
 * makes two concurrent calls safe. The LLM loop runs a step's tool calls
 * concurrently: under a plain read-then-await both calls would read step one,
 * both do it, and both record it. Taking the step off the head of the plan
 * inside a synchronous `update` is atomic, so the second call claims step two —
 * strictly better than the lock this replaced, which serialized two model calls
 * behind each other to get the same guarantee. A step whose work then FAILS is
 * put back, because a failed model call is worth retrying and a silently dropped
 * step leaves the caller with a plan that skipped something.
 *
 * **`when: "working"` replaced two hand-rolled guards** — the `!plan.objective`
 * check and the already-answered one — and neither was a data check: both asked
 * where the conversation was. See {@link planFlow}. The flow is what refuses now,
 * naming the state and quoting its instruction, so this body only ever runs when
 * there is a plan in progress.
 *
 * **`ANSWERED` is sent only when the replanner produced a RESPONSE.** A plan
 * that merely ran out of steps stays in `working`: nothing was concluded, and
 * the caller can still revise or add to it. Conflating the two would announce an
 * answer that does not exist.
 */
export default planFlow.tool({
  description:
    "Do the next step of the plan and report what it found. Call this once per " +
    "step — never in a loop. Say a short 'let me look into that' first, since " +
    "the step may take a few seconds.",
  when: "working",
  async execute(_args, ctx) {
    // The whole read-and-claim, in one window nothing can interleave with.
    const claimed = planSlot.update(ctx, (plan): Claim => {
      // `when: "working"` means there IS a plan, so this arm is unreachable by
      // the flow's own guarantee — kept because the slot and the flow are two
      // values, and a plan cleared by something else should refuse rather than
      // claim a step off an empty objective.
      if (!plan.objective) {
        return { kind: "failed", failure: toolFailure("There is no plan yet — use start_plan.") };
      }
      const step = plan.plan.shift();
      if (!step) return { kind: "dry" };
      return {
        kind: "step",
        step,
        objective: plan.objective,
        pastSteps: [...plan.pastSteps] as PastStep[],
      };
    });
    if (claimed.kind === "failed") return claimed.failure;
    if (claimed.kind === "dry") {
      // `response: undefined` is spelled out rather than omitted: `sendFrom`
      // below reads that field to decide whether to send ANSWERED, and a key
      // missing from one arm of a union is not readable on the union at all.
      return {
        finished: true,
        response: undefined,
        message: "No steps are left. Ask the caller what they want next.",
      };
    }
    const { step, objective, pastSteps } = claimed;

    try {
      const outcome = await executeStep(ctx.generate, liveSearch, objective, step, pastSteps);
      planSlot.update(ctx, (plan) => {
        // Capped: `historyOf` renders this whole list into two prompts, so an
        // append with no bound is a model bill that grows with the plan.
        recordStep(plan, { step, result: outcome.result, searches: outcome.searches });
      });

      // Their `replan_step`: the plan after a step is whatever still needs
      // doing, decided from the result rather than from what was planned before
      // anyone knew it.
      const act = await replanNode(ctx.generate, planSlot.get(ctx));
      return planSlot.update(ctx, (plan) => {
        if (act.kind === "respond") {
          plan.response = act.response;
          plan.plan = [];
          noteRevision(plan, `Finished after ${plan.pastSteps.length} step(s)`);
          return {
            finished: true,
            step,
            result: outcome.result,
            searches: outcome.searches,
            response: act.response,
            message: "The plan is done — give the caller the answer.",
          };
        }

        const changed = act.steps.join("|") !== plan.plan.join("|");
        plan.plan = act.steps;
        if (changed) noteRevision(plan, `Replanned to ${act.steps.length} step(s) after: ${step}`);
        return {
          finished: false,
          step,
          result: outcome.result,
          searches: outcome.searches,
          remaining: act.steps,
          message: "Report what this step found, then ask whether to carry on.",
        };
      });
    } catch (err: unknown) {
      // Put the claimed step back at the head, where a retry will find it.
      planSlot.update(ctx, (plan) => {
        plan.plan.unshift(step);
      });
      return toolFailure(`That step could not be worked: ${errorMessage(err)}`);
    }
  },
  // Written BELOW `execute` deliberately. `sendFrom`'s parameter is
  // `Exclude<NoInfer<R>, ToolFailure>`, and `NoInfer` keeps it from bidding on
  // `R` — but this body's own return type is itself an inference
  // (`planSlot.update`'s), so with `sendFrom` first there is no candidate to
  // contextually type it against and the parameter lands as `unknown`.
  sendFrom: (outcome) =>
    outcome.response === undefined ? undefined : ({ type: "ANSWERED" } as const),
});
