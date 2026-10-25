import {
  type DeepReadonly,
  isToolFailure,
  type ResolveOneOptions,
  resolveOne,
  toolFailure,
  withInstruction,
} from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { triageEmail } from "../nodes.ts";
import { draftingBrief, threadText } from "../prompts.ts";
import { readBackFor } from "../review.ts";
import {
  ALLOWED,
  AT_INBOX,
  assistantSlot,
  type FrozenAssistantState,
  findEmail,
  type InboxEmail,
  nextToOpen,
  reviewFlow,
  similarExamples,
} from "../shared.ts";

/**
 * How the executive refers to an email when they are not reading an id: by who
 * sent it and what it is about. The SENDER and SUBJECT only, because a body
 * match on "meeting" would tie half the inbox.
 */
const BY_WHAT_IT_IS: ResolveOneOptions<DeepReadonly<InboxEmail>> = {
  label: "email",
  describe: (email) => `${email.id}: "${email.subject}" from ${email.from}`,
  match: (email) => `${email.from} ${email.subject}`,
};

/**
 * The email the executive named — and the two ways they name one are two
 * different problems.
 *
 * An ID came off a list this desk read out, so an exact lookup is the whole
 * answer and a miss means no such email. THEIR OWN WORDS — "the one from Dana",
 * "the second one" — are a pick among eight rows that look alike, where taking
 * the first overlap opens the wrong thread and drafts a reply in the
 * executive's name against it. So `resolveOne` owns that half: a position is
 * taken as read, and nothing matching and several matching are DIFFERENT
 * answers, each naming what it could have meant so the assistant can ask.
 */
function pick(state: FrozenAssistantState, which: string) {
  const byId = findEmail(state.emails, which);
  if (byId) return byId;
  const live = state.emails.filter((email) => email.status !== "closed");
  return resolveOne(live, which, BY_WHAT_IT_IS);
}

/**
 * Start one thread's run — their graph's entry, from `triage_input` to the
 * first node that needs a model.
 *
 * **The instruction IS the brief.** Their `draft_response` node reads
 * `EMAIL_WRITING_INSTRUCTIONS` with the four memory prompts interpolated; a
 * voice session's prompt is fixed at connect and memory changes mid-call, so the
 * same text rides this tool's result as its instruction — the last thing the
 * model reads before it chooses a drafting tool, with whatever memory says NOW.
 *
 * Their `route_after_triage` is `sendFrom`: a `notify` skips drafting and lands
 * straight in `awaitingDecision` with a heads-up staged, as their `notify` node
 * halts for the human without drafting anything; `email` and `question` go to
 * `drafting`. A `no` the executive opens anyway is opened — their `--rerun` —
 * with the verdict in the result so the model knows it was filed.
 *
 * An untriaged email is triaged on the way in (`prepare`), so "open the one
 * from Dana" works before `triage_inbox` has run.
 */
export default assistantSlot.updateTool(
  {
    description:
      "Open the next email that needs the executive — or the one they named, by id or in their " +
      "own words — and get the thread plus your brief for handling it. Replies come before " +
      "heads-ups. One email is open at a time; settle it before opening another.",
    ui: { icon: "\u{2709}", label: "Opening email" },
    dialog: reviewFlow,
    when: AT_INBOX,
    inputSchema: z.object({
      which: z
        .string()
        .max(120)
        .describe(
          "An email id from triage_inbox or inbox_status, or how the executive referred to it " +
            "in their own words — who sent it, what it is about, or which one in the list. " +
            "Leave it out for the next one that needs them.",
        )
        .optional(),
    }),
    prepare: async (args, state, ctx) => {
      const target = args.which ? pick(state, args.which) : nextToOpen(state);
      if (isToolFailure(target)) return target;
      if (!target) {
        return toolFailure(
          "Nothing is queued. Run triage_inbox if you have not; otherwise the inbox is done.",
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
      return { id: target.id, verdict };
    },
    execute: (_args, draft, { id, verdict }) => {
      const email = findEmail(draft.emails, id);
      // An email never leaves the inbox and the id is this session's own, so
      // this is a bug rather than an outcome — and not a `ToolFailure`, which
      // the `sendFrom` below could not subtract from the result it reads.
      if (!email) throw new Error(`Email ${id} vanished between prepare and the window.`);
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
        return withInstruction(
          { route: "notify" as const, email: thread, triage: verdict, allowed: ALLOWED.notify },
          readBackFor(proposal),
        );
      }
      return withInstruction(
        { route: "draft" as const, email: thread, triage: verdict, reopened },
        (verdict.response === "no"
          ? `Triage filed this one as not worth a reply; ${EXECUTIVE.name} opened it anyway, so only draft if they ask. `
          : "") + draftingBrief(EXECUTIVE, draft.memory),
      );
    },
  },
  {
    // Their `route_after_triage`. In the second argument, where a `prepare`'s
    // result type has already settled before the transition is checked.
    sendFrom: (result) => ({ type: result.route === "notify" ? "NOTIFY" : "OPENED" }),
  },
);
