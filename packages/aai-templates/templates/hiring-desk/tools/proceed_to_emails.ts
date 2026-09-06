import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { partitionSettled } from "@alexkroman1/aai/step";
import { z } from "zod";
import { draftEmails } from "../crews.ts";
import {
  describeRanked,
  hiringFlow,
  hiringSlot,
  type RankedCandidate,
  resolveCandidate,
  SHORTLIST_SIZE,
  topCandidates,
} from "../shared.ts";

/**
 * Their option 3 — "Proceed with writing emails to all leads" — which returned
 * `"generate_emails"` and so ran `write_and_save_emails`: EVERY candidate gets
 * an email, and whether it invites or declines is decided by membership in
 * `top_candidate_ids`, the top three of the ranking.
 *
 * **The shortlist may be spoken.** Theirs is fixed to the top three, which is
 * right for a script and wrong for a hiring manager who has just heard the
 * ranking and says "go with the top three, but swap Marcus for Aisha". So the
 * default is their default, and a caller who names people gets those people —
 * resolved against the ranking with the never-guess rule, since the
 * consequence of a guess here is inviting the wrong candidate to interview.
 *
 * **Gated on `reviewing`, and it moves to `emailed`.** Emails for a ranking
 * nobody has reviewed is the failure the dialog exists to prevent; emails
 * twice for one ranking is the other, and `emailed` accepts no `PROCEEDED`.
 *
 * **A draft the guardrail never accepted still comes back**, flagged
 * `accepted: false`, and the desk is told to say it needs a look. There IS an
 * email; the caller is on the phone; what must not happen is presenting an
 * unsigned draft as finished.
 */
export default hiringFlow.tool({
  description:
    "Write a follow-up email to every applicant: an interview invitation to the shortlist " +
    "and a polite decline to everyone else. By default the shortlist is the top three; pass " +
    "names only if the caller changed it. Tell the caller it takes a moment first.",
  inputSchema: z.object({
    shortlist: z
      .array(z.string().max(120))
      .max(SHORTLIST_SIZE * 2)
      .optional()
      .describe(
        "Who to invite, by name or position in the ranking, ONLY when the caller named a " +
          "shortlist other than the top three",
      ),
  }),
  when: "reviewing",
  send: { type: "PROCEEDED" },
  async execute(args, ctx) {
    const state = hiringSlot.get(ctx);
    if (!state.job) return toolFailure("Nothing has been screened yet — use screen_candidates.");

    let chosen: RankedCandidate[];
    if (args.shortlist && args.shortlist.length > 0) {
      chosen = [];
      for (const spoken of args.shortlist) {
        const picked = resolveCandidate(state, spoken);
        if (isToolFailure(picked)) return picked;
        if (!chosen.some((one) => one.id === picked.id)) chosen.push(picked);
      }
    } else {
      chosen = topCandidates(state);
    }
    if (chosen.length === 0) {
      return toolFailure("Nobody is on the shortlist — there is no ranking to invite from.");
    }

    const shortlist = new Set(chosen.map((candidate) => candidate.id));
    const drafted = await draftEmails(ctx.delegate, state.candidates, state.job, shortlist);

    const { failed } = partitionSettled(drafted);
    if (failed.length === drafted.length) {
      return toolFailure(
        `No email could be written. The first failure said: ${failed[0]?.error ?? "no reason given"}`,
      );
    }

    return hiringSlot.update(ctx, (current) => {
      current.shortlist = [...shortlist];
      current.drafts = [];
      for (const one of drafted) if (one.ok) current.drafts.push(one.value);

      const needsLook = current.drafts
        .filter((draft) => !draft.accepted)
        .map((draft) => current.candidates.find((c) => c.id === draft.candidateId)?.name);
      const invited = chosen.map(describeRanked);
      return {
        invited,
        declined: current.drafts.filter((draft) => !draft.proceed).length,
        drafted: current.drafts.length,
        failed: failed.map((one) => one.item.name),
        needsLook,
        message:
          `Say the invitations went to ${invited.join(", ")} and how many polite declines ` +
          "were written, then offer to read any one of them back with read_email." +
          (needsLook.length > 0
            ? ` The drafts for ${needsLook.join(", ")} did not pass the coordinator's own check — say they need a look before sending.`
            : "") +
          (failed.length > 0
            ? ` No email could be written for ${failed.map((one) => one.item.name).join(", ")} — say so.`
            : ""),
      };
    });
  },
});
