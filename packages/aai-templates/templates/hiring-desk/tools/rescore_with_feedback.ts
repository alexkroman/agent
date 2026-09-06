import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { scoreRoster } from "../crews.ts";
import {
  describeRanked,
  hiringFlow,
  hiringSlot,
  MAX_FEEDBACK_ROUNDS,
  noteFeedback,
  ranked,
  topCandidates,
} from "../shared.ts";

/**
 * Their option 2 — "Redo lead scoring with additional feedback" — which set
 * `scored_leads_feedback` and returned `"scored_leads_feedback"`, the event
 * `score_leads` also `@listen`s to. That is the cycle in their flow, and this
 * is it: the same evaluator over the same roster, with the caller's words
 * added to every brief.
 *
 * **Gated on `reviewing`**, because feedback on a ranking needs a ranking:
 * their router is only reachable after `score_leads`, and `when` is the same
 * fact stated once instead of as an `if (!state.job)` at the top of the body.
 *
 * **Bounded, which theirs is not.** {@link MAX_FEEDBACK_ROUNDS} is their
 * `self_evaluation_loop_flow`'s `retry_count` guard applied to this loop; past
 * it the refusal names the two remaining choices. A `ToolFailure` rather than a
 * final state, because the caller can still proceed or ask about a candidate —
 * what they cannot do is spend a fourth round of model calls.
 *
 * **Feedback ACCUMULATES.** Their `input()` overwrote the previous round's
 * feedback, so "more weight on TypeScript" followed by "and less on years of
 * experience" lost the first. A caller means both.
 */
export default hiringFlow.tool({
  description:
    "Score every applicant again, applying the caller's feedback about what they are " +
    "looking for. Pass the feedback in their own words. Reports the new top three and who " +
    "moved.",
  inputSchema: z.object({
    feedback: z
      .string()
      .max(500)
      .describe("What the caller wants weighted differently, as they said it"),
  }),
  when: "reviewing",
  send: { type: "SCORED" },
  async execute(args, ctx) {
    const feedback = args.feedback.trim();
    if (feedback === "") return toolFailure("Say what the caller wants changed about the ranking.");

    const before = hiringSlot.get(ctx);
    if (before.rounds >= MAX_FEEDBACK_ROUNDS) {
      return toolFailure(
        `That would be round ${before.rounds + 1} of feedback and the limit is ` +
          `${MAX_FEEDBACK_ROUNDS}. Offer to proceed to emails with the current shortlist, ` +
          "or to stop here.",
      );
    }
    // `when: "reviewing"` guarantees a screening ran, so this arm is unreachable
    // by the flow's own guarantee — kept because the slot and the flow are two
    // values, and a job cleared by something else should refuse rather than
    // score twelve people against nothing.
    if (!before.job) return toolFailure("Nothing has been screened yet — use screen_candidates.");

    const previousTop = topCandidates(before).map((candidate) => candidate.id);
    const trail = [...before.feedback, feedback];
    const scored = await scoreRoster(ctx.generate, before.candidates, before.job, trail);

    const failed = scored.filter((one) => !one.ok);
    if (failed.length === scored.length) {
      return toolFailure(
        "No candidate could be re-scored, so the ranking is unchanged. The first failure " +
          `said: ${failed[0]?.ok === false ? failed[0].error : "no reason given"}`,
      );
    }

    return hiringSlot.update(ctx, (state) => {
      noteFeedback(state, feedback);
      state.rounds += 1;
      state.scores = {};
      state.unscored = [];
      for (const one of scored) {
        if (one.ok) state.scores[one.candidate.id] = one.verdict;
        else state.unscored.push(one.candidate.id);
      }

      const top = topCandidates(state);
      const topIds = top.map((candidate) => candidate.id);
      const nameOf = new Map(state.candidates.map((candidate) => [candidate.id, candidate.name]));
      const promoted = topIds.filter((id) => !previousTop.includes(id)).map((id) => nameOf.get(id));
      const dropped = previousTop.filter((id) => !topIds.includes(id)).map((id) => nameOf.get(id));
      const roundsLeft = MAX_FEEDBACK_ROUNDS - state.rounds;

      return {
        round: state.rounds,
        roundsLeft,
        feedbackApplied: state.feedback,
        top: top.map((candidate) => ({
          rank: candidate.rank,
          name: candidate.name,
          score: candidate.score,
          reason: candidate.reason,
        })),
        promoted,
        dropped,
        ranked: ranked(state).length,
        message:
          (promoted.length === 0
            ? "The top three are the same people, possibly in a different order — say so. "
            : `Say who moved in (${promoted.join(", ")}) and who moved out (${dropped.join(", ")}). `) +
          `Then read the top three — ${top.map(describeRanked).join("; ")} — and offer the ` +
          "same three choices" +
          (roundsLeft === 0
            ? ", noting this was the last round of feedback; from here it is proceed or stop."
            : "."),
      };
    });
  },
});
