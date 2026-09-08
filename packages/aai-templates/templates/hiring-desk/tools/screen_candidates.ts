import { omitUndefined, tool, toolFailure } from "@alexkroman1/aai";
import { partitionSettled } from "@alexkroman1/aai/step";
import { z } from "zod";
import { scoreRoster } from "../crews.ts";
import { withScreening } from "../screening-lock.ts";
import {
  DEFAULT_JOB,
  describeRanked,
  hiringFlow,
  hiringSlot,
  type JobDescription,
  LEADS,
  progressTicker,
  SCORED,
  topCandidates,
} from "../shared.ts";

/**
 * Their `@start() load_leads` and the `score_leads` that `@listen`s to it, as
 * one tool — nothing happens between the two that a caller could speak into.
 *
 * **An ordinary `tool()` and not a `hiringFlow.tool`, deliberately.** `SCORED`
 * is accepted in every state — a caller may start a fresh screening from the
 * shortlist or after the emails — so a `when` naming all three would be a gate
 * that gates nothing. It sends the event itself, which is what `dialog.send`
 * is public for, and spreads the position it landed in into its result.
 *
 * **The await comes first, then the mutation.** Twelve model calls run outside
 * the slot's synchronous window and the whole table lands at once, so a
 * `screening_status` read mid-fan-out sees the previous screening rather than
 * half of this one. What the caller gets in the meantime is the progress
 * ticker, which is an EVENT rather than state for the reason `shared.ts` gives
 * at {@link progressTicker}.
 *
 * **And the whole body is under the screening lock**, because "the await comes
 * first" is also what lets a SECOND screening in the same step interleave with
 * this one; `screening-lock.ts` has the two ways that goes wrong.
 */
export default tool({
  description:
    "Load the applicants and score every one of them against the role, then report the " +
    "top three. Use this once the caller has confirmed which role they are hiring for. " +
    "Tell them it will take a moment before you call it — it is one evaluation per applicant.",
  inputSchema: z.object({
    jobTitle: z
      .string()
      .max(120)
      .optional()
      .describe("The role, if the caller named one other than the default"),
    jobDescription: z
      .string()
      .max(2000)
      .optional()
      .describe("What the role needs, in the caller's words, when they described a role"),
  }),
  async execute(args, ctx) {
    // A title without a description screens against the default's description
    // under the caller's title; a description without a title keeps the default
    // title. Either is better than refusing a caller who gave one and not the other.
    const job: JobDescription = {
      title: args.jobTitle?.trim() || DEFAULT_JOB.title,
      description: args.jobDescription?.trim() || DEFAULT_JOB.description,
    };

    return withScreening(ctx, async () => {
      // A fresh screening: the roster is re-read (their `load_leads`), and the
      // feedback trail starts over — feedback was about a ranking for a role,
      // and this may be a different role.
      const scored = await scoreRoster(
        ctx.generate,
        LEADS,
        job,
        [],
        progressTicker(ctx, "scoring", LEADS.length),
      );

      const { failed } = partitionSettled(scored);
      if (failed.length === scored.length) {
        return toolFailure(
          `No candidate could be scored. The first failure said: ${failed[0]?.error ?? "no reason given"}`,
        );
      }

      // The flow moves first: `rescore_with_feedback` and `proceed_to_emails`
      // gate on `reviewing`, and a table written while the flow still said
      // `idle` would be refused by its own next tool call.
      const at = hiringFlow.send(ctx, SCORED);

      return hiringSlot.update(ctx, (state) => {
        state.job = job;
        state.candidates = [...LEADS];
        state.scores = {};
        state.unscored = [];
        state.feedback = [];
        state.rounds = 0;
        state.shortlist = [];
        state.drafts = [];
        for (const one of scored) {
          if (one.ok) state.scores[one.item.id] = one.value;
          else state.unscored.push(one.item.id);
        }

        const top = topCandidates(state);
        return {
          job: job.title,
          screened: scored.length - failed.length,
          top: top.map((candidate) => ({
            rank: candidate.rank,
            name: candidate.name,
            score: candidate.score,
            reason: candidate.reason,
          })),
          ...omitUndefined({
            unscored: failed.length > 0 ? failed.map((one) => one.item.name).join(", ") : undefined,
          }),
          message:
            `Read the top three back — ${top.map(describeRanked).join("; ")} — with one sentence ` +
            "of reasoning each, then offer the three choices: score again with feedback, proceed " +
            "to emails, or stop here." +
            (failed.length > 0
              ? " Mention who could not be scored and offer to run the screening again."
              : ""),
          ...at,
        };
      });
    });
  },
});
