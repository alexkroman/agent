import { toolFailure } from "@alexkroman1/aai";
import { partitionSettled } from "@alexkroman1/aai/step";
import { z } from "zod";
import { scoreRoster } from "../crews.ts";
import { withScreening } from "../screening-lock.ts";
import {
  describeRanked,
  hiringFlow,
  hiringSlot,
  MAX_FEEDBACK_ROUNDS,
  progressTicker,
  ranked,
  SCORED,
  topCandidates,
} from "../shared.ts";

/**
 * Their option 2 — "Redo lead scoring with additional feedback", the cycle in
 * their flow: the same evaluator over the same roster, with the caller's words
 * added to every brief.
 *
 * **Gated on `reviewing`**, because feedback on a ranking needs a ranking.
 * **Bounded, which theirs is not**: {@link MAX_FEEDBACK_ROUNDS} is their
 * `self_evaluation_loop_flow`'s retry guard applied to this loop, and past it
 * the refusal names the two remaining choices. **Feedback ACCUMULATES** —
 * their `input()` overwrote the previous round, and a caller who said both
 * meant both.
 *
 * The round counter is read in `prepare` and written in `commit`, a
 * read-modify-write across a fan-out, which is why the whole transaction runs
 * under the screening lock (`screening-lock.ts`).
 */
export default hiringFlow.tool({
  description:
    "Score every applicant again, applying the caller's feedback about what they are " +
    "looking for. Pass the feedback in their own words. Reports the new top three and who " +
    "moved.",
  ui: { icon: "\u{1F501}", label: "Scoring again with feedback" },
  inputSchema: z.object({
    feedback: z
      .string()
      .max(500)
      .describe("What the caller wants weighted differently, as they said it"),
  }),
  when: "reviewing",
  send: SCORED,
  execute(args, ctx) {
    const feedback = args.feedback.trim();
    if (feedback === "") return toolFailure("Say what the caller wants changed about the ranking.");

    return withScreening(ctx, () =>
      hiringSlot.transact(ctx, {
        require: (before) =>
          before.rounds >= MAX_FEEDBACK_ROUNDS
            ? toolFailure(
                `That would be round ${before.rounds + 1} of feedback and the limit is ` +
                  `${MAX_FEEDBACK_ROUNDS}. Offer to proceed to emails with the current shortlist, ` +
                  "or to stop here.",
              )
            : undefined,
        prepare: async (before) => {
          // Unreachable by the flow's own guarantee (`reviewing` means a
          // screening ran); kept because the slot and the flow are two values.
          const job = before.job;
          if (!job) return toolFailure("Nothing has been screened yet — use screen_candidates.");
          const previousTop = topCandidates(before).map((candidate) => candidate.id);
          const scored = await scoreRoster(
            ctx.generate,
            before.candidates,
            job,
            [...before.feedback, feedback],
            progressTicker(ctx, "scoring", before.candidates.length),
          );
          const { failed } = partitionSettled(scored);
          if (failed.length === scored.length) {
            return toolFailure(
              "No candidate could be re-scored, so the ranking is unchanged. The first failure " +
                `said: ${failed[0]?.error ?? "no reason given"}`,
            );
          }
          return { scored, previousTop };
        },
        commit: (state, { scored, previousTop }) => {
          state.feedback.push(feedback);
          state.rounds += 1;
          state.scores = {};
          state.unscored = [];
          for (const one of scored) {
            if (one.ok) state.scores[one.item.id] = one.value;
            else state.unscored.push(one.item.id);
          }

          const top = topCandidates(state);
          const topIds = top.map((candidate) => candidate.id);
          const nameOf = new Map(
            state.candidates.map((candidate) => [candidate.id, candidate.name]),
          );
          const promoted = topIds
            .filter((id) => !previousTop.includes(id))
            .map((id) => nameOf.get(id));
          const dropped = previousTop
            .filter((id) => !topIds.includes(id))
            .map((id) => nameOf.get(id));
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
        },
      }),
    );
  },
});
