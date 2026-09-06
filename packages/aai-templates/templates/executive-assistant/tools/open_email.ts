import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { triageEmail } from "../nodes.ts";
import { draftingBrief, threadText } from "../prompts.ts";
import { readBackFor } from "../review.ts";
import {
  ALLOWED,
  AT_INBOX,
  assistantSlot,
  findEmail,
  nextToOpen,
  reviewFlow,
  similarExamples,
} from "../shared.ts";

/**
 * Start one thread's run — their graph's entry, from `triage_input` to the
 * first node that needs a model.
 *
 * **The result IS the brief.** Their `draft_response` node reads
 * `EMAIL_WRITING_INSTRUCTIONS` with the four memory prompts interpolated; a
 * voice session's prompt is fixed at connect and memory changes mid-call, so the
 * same text comes back as this tool's result — the last thing the model reads
 * before it chooses a drafting tool, with whatever memory says NOW.
 *
 * Their `route_after_triage` is `sendFrom`: a `notify` skips drafting and lands
 * straight in `awaitingDecision` with a heads-up staged, as their `notify` node
 * halts for the human without drafting anything; `email` and `question` go to
 * `drafting`. A `no` the executive opens anyway is opened — their `--rerun` —
 * with the verdict in the result so the model knows it was filed.
 *
 * An untriaged email is triaged on the way in, so "open the one from Dana" works
 * before `triage_inbox` has run.
 */
export default reviewFlow.tool({
  description:
    "Open the next email that needs the executive — or a specific one by id — and get the " +
    "thread plus your brief for handling it. Replies come before heads-ups. One email is " +
    "open at a time; settle it before opening another.",
  when: AT_INBOX,
  inputSchema: z.object({
    id: z.string().max(20).describe("An email id from triage_inbox or inbox_status").optional(),
  }),
  async execute(args, ctx) {
    const state = assistantSlot.get(ctx);
    const target = args.id ? findEmail(state.emails, args.id) : nextToOpen(state);
    if (!target) {
      return toolFailure(
        args.id
          ? `No email ${args.id}. Ids: ${state.emails.map((email) => email.id).join(", ")}.`
          : "Nothing is queued. Run triage_inbox if you have not; otherwise the inbox is done.",
      );
    }
    const verdict =
      target.triage ??
      (await triageEmail(
        ctx.generate,
        EXECUTIVE,
        target,
        similarExamples(state.triageExamples, target),
      ));
    return assistantSlot.update(ctx, (draft) => {
      const email = findEmail(draft.emails, target.id);
      if (!email) return toolFailure(`Email ${target.id} disappeared.`);
      const reopened = email.status === "closed";
      email.triage = verdict;
      email.status = "open";
      draft.openId = email.id;
      draft.exchange = [`Draft a response to this email:\n\n${threadText(email)}`];
      draft.log.push(`Opened: ${email.subject} (${verdict.response})`);
      const thread = {
        id: email.id,
        from: email.from,
        to: email.to,
        subject: email.subject,
        sentAt: email.sentAt,
        body: email.body,
      };
      if (verdict.response === "notify") {
        const proposal = { kind: "notify" as const };
        draft.proposal = proposal;
        draft.exchange.push("Assistant proposed — Heads-up: no reply needed.");
        return {
          route: "notify" as const,
          email: thread,
          triage: verdict,
          allowed: ALLOWED.notify,
          instructions: readBackFor(proposal),
        };
      }
      return {
        route: "draft" as const,
        email: thread,
        triage: verdict,
        reopened,
        instructions:
          (verdict.response === "no"
            ? `Triage filed this one as not worth a reply; ${EXECUTIVE.name} opened it anyway, so only draft if they ask. `
            : "") + draftingBrief(EXECUTIVE, draft.memory),
      };
    });
  },
  sendFrom: (result) => ({ type: result.route === "notify" ? "NOTIFY" : "OPENED" }),
});
