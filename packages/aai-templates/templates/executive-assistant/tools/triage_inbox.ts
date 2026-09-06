import { EXECUTIVE } from "../inbox.ts";
import { triageEmail } from "../nodes.ts";
import {
  assistantSlot,
  closeEmail,
  findEmail,
  note,
  reviewFlow,
  similarExamples,
} from "../shared.ts";

/**
 * Their `triage_input`, over every email that has not been triaged yet.
 *
 * **All of them at once, and that is the voice adaptation.** Their cron runs the
 * graph once per thread as mail arrives; a caller wants to hear the shape of the
 * inbox before opening anything, so the verdicts are fetched concurrently and
 * applied in one window. Their `route_after_triage` is applied here too: a `no`
 * is marked read on the spot (`filed`), and only `email`, `question` and
 * `notify` are queued for the executive.
 *
 * The few-shot examples are chosen per email from what THIS call has settled —
 * their `get_few_shot_examples`, over the session's own store.
 */
export default reviewFlow.tool({
  description:
    "Triage every new email: decide which need a reply, which are just worth knowing " +
    "about, and which to file unread. Call this first on a call, and again if new mail is " +
    "mentioned. Tell the executive the counts, then open_email.",
  when: "onCall",
  async execute(_args, ctx) {
    const state = assistantSlot.get(ctx);
    const pending = state.emails.filter((email) => email.status === "untriaged");
    const verdicts = await Promise.all(
      pending.map(async (email) => ({
        id: email.id,
        verdict: await triageEmail(
          ctx.generate,
          EXECUTIVE,
          email,
          similarExamples(state.triageExamples, email),
        ),
      })),
    );
    return assistantSlot.update(ctx, (draft) => {
      const filed: string[] = [];
      for (const { id, verdict } of verdicts) {
        const email = findEmail(draft.emails, id);
        if (!email) continue;
        email.triage = verdict;
        if (verdict.response === "no") {
          closeEmail(draft, email.id, "filed");
          filed.push(email.subject);
        } else {
          email.status = "queued";
        }
      }
      if (verdicts.length > 0) {
        note(
          draft,
          `Triaged ${verdicts.length}: ${verdicts.length - filed.length} queued, ${filed.length} filed`,
        );
      }
      const queued = draft.emails.filter((email) => email.status === "queued");
      const brief = (email: (typeof queued)[number]) => ({
        id: email.id,
        from: email.from,
        subject: email.subject,
        why: email.triage?.logic ?? "",
      });
      return {
        triaged: verdicts.length,
        needReply: queued.filter((email) => email.triage?.response !== "notify").map(brief),
        headsUp: queued.filter((email) => email.triage?.response === "notify").map(brief),
        filed,
        next:
          queued.length > 0
            ? `Say how many need ${EXECUTIVE.name}, then open_email to start with the first.`
            : "The inbox is clear.",
      };
    });
  },
});
