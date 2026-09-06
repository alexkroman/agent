import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { draftFor, hiringSlot, resolveCandidate } from "../shared.ts";

/**
 * Their `email_responses/<name>.txt`, opened.
 *
 * Their flow writes thirty files and exits; whoever wanted to read one opened
 * a folder. A desk on a phone reads the draft back, and this is the tool that
 * fetches it. Not gated on `emailed`: a data check ("no draft for this person
 * yet") answers the empty case better than a position refusal, because it can
 * say WHICH — the caller may be asking about someone the screening did not
 * include.
 */
export default hiringSlot.tool({
  description:
    "Read back the follow-up email drafted for one applicant. Use it after the emails have " +
    "been written, when the caller asks to hear one.",
  inputSchema: z.object({
    candidate: z
      .string()
      .max(120)
      .describe("The applicant, by name or by position in the ranking as the caller said it"),
  }),
  execute(args, state) {
    if (state.drafts.length === 0) {
      return toolFailure(
        "No emails have been drafted yet — proceed_to_emails writes them once the shortlist " +
          "is settled.",
      );
    }
    const picked = resolveCandidate(state, args.candidate);
    if (isToolFailure(picked)) return picked;
    const draft = draftFor(state, picked.id);
    if (!draft) {
      return toolFailure(`No email was written for ${picked.name} — the coordinator's run failed.`);
    }
    return {
      to: picked.name,
      kind: draft.proceed ? "invitation" : "decline",
      subject: draft.subject,
      body: draft.body,
      accepted: draft.accepted,
      message: draft.accepted
        ? "Say the subject line, then read the body at a natural pace. Offer to change anything."
        : "This draft did not pass the coordinator's check — say so before reading it, and " +
          "offer to have it rewritten rather than sent as is.",
    };
  },
});
