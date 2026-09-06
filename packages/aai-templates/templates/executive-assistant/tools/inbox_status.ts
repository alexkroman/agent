import { assistantSlot } from "../shared.ts";

/**
 * What is left — a READ, so it is the slot's own `tool` and gated on nothing:
 * "what else is there?" is a fair question from anywhere on the call.
 */
export default assistantSlot.tool({
  description:
    "Where the inbox stands: what is open, what is still queued, and what has been sent " +
    "or filed. Use it when the executive asks what is left or what has been done.",
  execute: (_args, state) => ({
    open: state.openId,
    queued: state.emails
      .filter((email) => email.status === "queued")
      .map((email) => ({
        id: email.id,
        from: email.from,
        subject: email.subject,
        triage: email.triage?.response ?? null,
      })),
    untriaged: state.emails.filter((email) => email.status === "untriaged").length,
    closed: state.emails
      .filter((email) => email.status === "closed")
      .map((email) => ({ id: email.id, subject: email.subject, as: email.closedAs })),
    sent: state.sent.map((item) => item.summary),
  }),
});
