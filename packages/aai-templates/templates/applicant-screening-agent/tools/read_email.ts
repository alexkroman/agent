import { isToolFailure, toolFailure, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { draftFor, hiringSlot, resolveCandidate } from "../shared.ts";

/**
 * Their `email_responses/<name>.txt`, opened: a desk on a phone reads the
 * draft back. Not gated on `emailed` — a data check ("no draft for this
 * person yet") answers the empty case better than a position refusal, because
 * it can say WHICH.
 */
export default hiringSlot.tool({
  description:
    "Read back the follow-up email drafted for one applicant. Use it after the emails have " +
    "been written, when the caller asks to hear one.",
  ui: { icon: "\u{1F4E8}", label: "Reading a draft" },
  inputSchema: z.object({
    candidate: z
      .string()
      .max(120)
      .describe("The applicant, by name or by position in the ranking as the caller said it"),
  }),
  require: (state) =>
    state.drafts.length === 0
      ? toolFailure(
          "No emails have been drafted yet — proceed_to_emails writes them once the shortlist " +
            "is settled.",
        )
      : undefined,
  execute(args, state) {
    const picked = resolveCandidate(state, args.candidate);
    if (isToolFailure(picked)) return picked;
    const draft = draftFor(state, picked.id);
    if (!draft) {
      return toolFailure(`No email was written for ${picked.name} — the coordinator's run failed.`);
    }
    return withInstruction(
      {
        to: picked.name,
        kind: draft.proceed ? "invitation" : "decline",
        subject: draft.subject,
        body: draft.body,
        accepted: draft.accepted,
      },
      draft.accepted
        ? "Say the subject line, then read the body at a natural pace. Offer to change anything."
        : "This draft did not pass the coordinator's check — say so before reading it, and " +
            "offer to have it rewritten rather than sent as is.",
    );
  },
});
