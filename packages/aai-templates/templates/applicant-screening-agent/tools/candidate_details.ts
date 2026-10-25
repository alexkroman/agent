import { isToolFailure, toolFailure, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { draftFor, hiringSlot, resolveCandidate } from "../shared.ts";

/**
 * One candidate in full — the bio their evaluator read, the score it gave, and
 * where that puts them. A hiring manager who has just heard "Priya, 87" asks
 * "what has she actually done?" and the desk owes an answer without another
 * model call. The candidate is named the way a caller names one — a first
 * name, a surname, or "the second one" — against the RANKING they were read.
 */
export default hiringSlot.tool({
  description:
    "Tell the caller about one applicant: their background, skills, score, reasoning and " +
    "rank. Accepts a name or a position in the ranking such as 'the second one'.",
  ui: { icon: "\u{1F464}", label: "Looking up an applicant" },
  inputSchema: z.object({
    candidate: z
      .string()
      .max(120)
      .describe("The applicant, by name or by position in the ranking as the caller said it"),
  }),
  require: (state) =>
    state.candidates.length === 0
      ? toolFailure("Nothing has been screened yet — use screen_candidates first.")
      : undefined,
  execute(args, state) {
    const picked = resolveCandidate(state, args.candidate);
    if (isToolFailure(picked)) return picked;
    const draft = draftFor(state, picked.id);
    return withInstruction(
      {
        rank: picked.rank,
        name: picked.name,
        score: picked.score,
        reason: picked.reason,
        bio: picked.bio,
        skills: picked.skills,
        shortlisted: state.shortlist.includes(picked.id),
        emailDrafted: draft ? (draft.proceed ? "invitation" : "decline") : null,
      },
      "Answer what was asked from this in a sentence or two — do not read the whole bio " +
        "unless they ask for it.",
    );
  },
});
