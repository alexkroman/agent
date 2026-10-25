import { omitUndefined, toolFailure } from "@alexkroman1/aai";
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
 * No `when`: `SCORED` is accepted in every state, since a caller may start a
 * fresh screening from the shortlist or after the emails. The twelve model
 * calls run in `prepare`, outside the slot's window, and the whole table lands
 * at once in `commit`, so a `screening_status` read mid-fan-out sees the
 * previous screening rather than half of this one; the caller gets the
 * progress ticker in the meantime. The transaction runs under the screening
 * lock, because a second screening in the same step would otherwise
 * interleave at the await (`screening-lock.ts`).
 */
export default hiringFlow.tool({
  description:
    "Load the applicants and score every one of them against the role, then report the " +
    "top three. Use this once the caller has confirmed which role they are hiring for. " +
    "Tell them it will take a moment before you call it — it is one evaluation per applicant.",
  ui: { icon: "\u{1F4CB}", label: "Scoring the applicants" },
  send: SCORED,
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
  execute(args, ctx) {
    // A title without a description screens against the default's description
    // under the caller's title, and the other way round; either beats refusing.
    const job: JobDescription = {
      title: args.jobTitle?.trim() || DEFAULT_JOB.title,
      description: args.jobDescription?.trim() || DEFAULT_JOB.description,
    };
    return withScreening(ctx, () =>
      hiringSlot.transact(ctx, {
        prepare: async () => {
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
          return { scored, failed };
        },
        // A fresh screening: the roster is re-read (their `load_leads`), and
        // the feedback trail starts over — this may be a different role.
        commit: (state, { scored, failed }) => {
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
              unscored:
                failed.length > 0 ? failed.map((one) => one.item.name).join(", ") : undefined,
            }),
            message:
              `Read the top three back — ${top.map(describeRanked).join("; ")} — with one sentence ` +
              "of reasoning each, then offer the three choices: score again with feedback, proceed " +
              "to emails, or stop here." +
              (failed.length > 0
                ? " Mention who could not be scored and offer to run the screening again."
                : ""),
          };
        },
      }),
    );
  },
});
