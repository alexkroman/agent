/**
 * The human gate: staging a proposal, and the four answers to one.
 *
 * This is their `human_inbox.py` — `send_email_draft`, `send_message`,
 * `notify`, `send_cal_invite`, each an `interrupt()` that halts the graph until
 * a person picks `accept`, `edit`, `ignore` or `respond` in the Agent Inbox —
 * turned inside out for a phone. There, the run halts and the four buttons are
 * the UI; here the assistant reads the proposal aloud and the FOUR TOOLS below
 * are what the executive's words become. Each is gated on `awaitingDecision`,
 * checks {@link ALLOWED} the way their `HumanInterruptConfig` does, and the
 * definitions live together because they share the two things that matter:
 * {@link applyProposal}, the one place anything is sent, and
 * {@link REFLECTION_SCOPE}, their `prompt_types` per human node.
 *
 * **What each answer does is theirs, line for line.** `accept` sends and
 * remembers the thread as a worked triage example. `edit` sends the executive's
 * version instead and reflects on "a better response would have been". `ignore`
 * marks the thread read and remembers it as one to skip. `respond` hands the
 * words back to the drafting model — as the answer to a question, or as the
 * "interrupted and gave this feedback" a draft comes back with — and reflects on
 * them. A reflection is two model calls or more, so the two tools that run one
 * are async and re-check the gate inside their write window: the executive's
 * answer may have been settled by a concurrent call while the model reflected.
 */

import {
  type DeepReadonly,
  isToolFailure,
  type ToolDef,
  type ToolFailure,
  toolFailure,
} from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "./inbox.ts";
import { applyReflection, describeUpdates, reflect } from "./nodes.ts";
import type { MemoryType } from "./prompts.ts";
import {
  ALLOWED,
  type AssistantState,
  AWAITING,
  assistantSlot,
  closeEmail,
  DRAFTING,
  describeProposal,
  type FrozenAssistantState,
  type HumanResponse,
  type InboxEmail,
  openEmail,
  type Proposal,
  type ProposalKind,
  rememberExample,
  reviewFlow,
  trajectoryOf,
} from "./shared.ts";

const { name } = EXECUTIVE;

// ─── Staging ─────────────────────────────────────────────────────────────────

/** What the assistant should SAY once a proposal is waiting — read aloud, so a question's worth. */
export function readBackFor(proposal: DeepReadonly<Proposal>): string {
  switch (proposal.kind) {
    case "reply":
    case "new_email":
      return `Read the draft to ${name} in full, in your own voice, then ask: send it, change something, or skip it? Nothing has been sent.`;
    case "invite":
      return `Read the meeting back to ${name} — who, what it is called, and when — and ask whether to send the invite. Nothing has been sent.`;
    case "question":
      return `Ask ${name} the question out loud. Their answer comes back through respond; ignore skips the email instead.`;
    case "notify":
      return `Tell ${name} about this email in one or two sentences and ask whether they want to do anything about it. Instructions come back through respond; ignore files it.`;
    default:
      return `Read it back to ${name} and ask what they want to do.`;
  }
}

/**
 * Stage a proposal and answer what a drafting tool answers with.
 *
 * Every drafting tool ends in this call and none of them send anything — that
 * is the whole gate. It REFUSES a second proposal: the LLM loop runs a step's
 * tool calls concurrently, so a model that hears "reply to Dana and book Sam"
 * may emit two, and an unconditional assignment would let the second silently
 * replace the first while both read back as staged.
 */
export function propose(state: AssistantState, proposal: Proposal) {
  const email = openEmail(state);
  if (!email) return toolFailure("No email is open. Call open_email first.");
  if (state.proposal) {
    return toolFailure(
      `Something is already waiting for ${name}'s answer: ${describeProposal(state.proposal).title}. ` +
        "Settle it with accept, edit, ignore or respond first. Nothing about this request was staged.",
    );
  }
  state.proposal = proposal;
  const { title, body } = describeProposal(proposal);
  state.exchange.push(`Assistant proposed — ${title}: ${body}`);
  state.log.push(`Waiting on ${name}: ${title}`);
  return {
    awaitingDecision: true as const,
    proposal: { kind: proposal.kind, title, body },
    allowed: ALLOWED[proposal.kind],
    readBack: readBackFor(proposal),
  };
}

// ─── Applying ────────────────────────────────────────────────────────────────

/** Their `HumanInterruptConfig`, enforced: is this answer offered for this proposal? */
function requireAllowed(
  proposal: DeepReadonly<Proposal>,
  response: HumanResponse,
): ToolFailure | undefined {
  const allowed = ALLOWED[proposal.kind];
  if (allowed.includes(response)) return undefined;
  return toolFailure(
    `${response} is not an answer to ${describeProposal(proposal).title.toLowerCase()} — ` +
      `only ${allowed.join(" or ")} are. Nothing was done.`,
  );
}

/**
 * Their `send_email_node` / `send_cal_invite_node`, then `mark_as_read`: the ONE
 * place anything leaves the building. Returns the sentence the assistant says.
 */
export function applyProposal(
  state: AssistantState,
  email: DeepReadonly<InboxEmail>,
  proposal: DeepReadonly<Proposal>,
): string | ToolFailure {
  const { title, body } = describeProposal(proposal);
  switch (proposal.kind) {
    case "reply": {
      const to = [email.from, ...proposal.newRecipients].join(", ");
      state.sent.push({
        emailId: email.id,
        kind: "reply",
        summary: `Reply to ${to}: ${email.subject}`,
      });
      closeEmail(state, email.id, "sent");
      state.log.push(`Sent reply to ${to}`);
      state.exchange.push(`Sent: ${body}`);
      return `Reply sent to ${to}.`;
    }
    case "new_email": {
      const to = proposal.recipients.join(", ");
      state.sent.push({ emailId: email.id, kind: "new_email", summary: `New email to ${to}` });
      closeEmail(state, email.id, "sent");
      state.log.push(`Sent new email to ${to}`);
      state.exchange.push(`Sent: ${body}`);
      return `New email sent to ${to}.`;
    }
    case "invite": {
      state.sent.push({ emailId: email.id, kind: "invite", summary: `${title} — ${body}` });
      closeEmail(state, email.id, "invited");
      state.log.push(`Sent ${title}`);
      state.exchange.push(`Sent ${title}: ${body}`);
      return `Calendar invite "${proposal.title}" sent for ${proposal.startTime}.`;
    }
    default:
      // Unreachable: `requireAllowed` refuses `accept`/`edit` on the other two.
      return toolFailure(`${title} is not something that can be sent.`);
  }
}

const EVERY_MEMORY: readonly MemoryType[] = ["tone", "email", "background", "calendar"];
const NO_TONE: readonly MemoryType[] = ["email", "background", "calendar"];

/** Their `prompt_types` per human node — which memories each answer may rewrite. */
export const REFLECTION_SCOPE: Record<
  ProposalKind,
  { edit: readonly MemoryType[]; respond: readonly MemoryType[] }
> = {
  reply: { edit: EVERY_MEMORY, respond: EVERY_MEMORY },
  new_email: { edit: EVERY_MEMORY, respond: EVERY_MEMORY },
  invite: { edit: NO_TONE, respond: NO_TONE },
  question: { edit: [], respond: ["background"] },
  notify: { edit: [], respond: NO_TONE },
};

/** What is waiting, or the refusal every settling tool starts with. */
function waiting(state: FrozenAssistantState) {
  const email = openEmail(state);
  const proposal = state.proposal;
  if (!(email && proposal)) {
    return toolFailure(
      `Nothing is waiting for ${name}'s answer. Open an email and stage something first.`,
    );
  }
  return { email, proposal };
}

// ─── The four answers ────────────────────────────────────────────────────────

/** `accept` — their `accept`: send it as proposed. */
export function acceptTool(): ToolDef {
  return reviewFlow.tool({
    description:
      `${name} said yes to what you just read back — send it as it is. Only after a clear ` +
      "yes; this is the one tool that actually sends. Not an answer to a question or a heads-up.",
    when: AWAITING,
    send: { type: "SETTLED" },
    execute: (_args, ctx) =>
      assistantSlot.update(ctx, (state) => {
        const it = waiting(state);
        if (isToolFailure(it)) return it;
        const denied = requireAllowed(it.proposal, "accept");
        if (denied) return denied;
        const sent = applyProposal(state, it.email, it.proposal);
        if (isToolFailure(sent)) return sent;
        rememberExample(state, it.email, "email");
        return { sent, next: `Tell ${name} it went out, then open_email for the next one.` };
      }),
  });
}

/** The edited proposal, or why the edit does not fit what is waiting. */
function editProposal(
  proposal: DeepReadonly<Proposal>,
  args: {
    content?: string | undefined;
    title?: string | undefined;
    startTime?: string | undefined;
    endTime?: string | undefined;
  },
): Proposal | ToolFailure {
  switch (proposal.kind) {
    case "reply":
      if (!args.content)
        return toolFailure("An edited reply needs the full new text in `content`.");
      return { ...proposal, content: args.content, newRecipients: [...proposal.newRecipients] };
    case "new_email":
      if (!args.content)
        return toolFailure("An edited email needs the full new text in `content`.");
      return { ...proposal, content: args.content, recipients: [...proposal.recipients] };
    case "invite":
      if (!(args.title || args.startTime || args.endTime)) {
        return toolFailure("An edited invite needs a new title, startTime or endTime.");
      }
      return {
        kind: "invite",
        emails: [...proposal.emails],
        title: args.title ?? proposal.title,
        startTime: args.startTime ?? proposal.startTime,
        endTime: args.endTime ?? proposal.endTime,
      };
    default:
      return toolFailure(`${describeProposal(proposal).title} cannot be edited.`);
  }
}

/**
 * `edit` — their `edit`: send the executive's own version, and learn from the
 * difference. The feedback string is theirs: "A better response would have been".
 */
export function editTool(): ToolDef {
  return reviewFlow.tool({
    description:
      `${name} dictated changes to the draft or the invite — send THEIR version. Give the ` +
      "whole corrected email text, not the change; for an invite, the fields that change. " +
      "Use respond instead when they want you to redraft it yourself.",
    when: AWAITING,
    send: { type: "SETTLED" },
    inputSchema: z.object({
      content: z.string().max(4000).describe("The full corrected email text").optional(),
      title: z.string().max(120).describe("Invite: the new title").optional(),
      startTime: z.string().max(40).describe("Invite: new start, 2026-03-17T14:00:00").optional(),
      endTime: z.string().max(40).describe("Invite: new end, 2026-03-17T14:30:00").optional(),
    }),
    async execute(args, ctx) {
      const before = assistantSlot.get(ctx);
      const it = waiting(before);
      if (isToolFailure(it)) return it;
      const denied = requireAllowed(it.proposal, "edit");
      if (denied) return denied;
      const edited = editProposal(it.proposal, args);
      if (isToolFailure(edited)) return edited;
      const feedback =
        edited.kind === "invite"
          ? `${name} interrupted and gave these instructions: ${describeProposal(edited).body}`
          : `A better response would have been: ${describeProposal(edited).body}`;
      const updates = await reflect(ctx.generate, {
        memory: before.memory,
        trajectory: trajectoryOf(before),
        feedback,
        promptTypes: REFLECTION_SCOPE[it.proposal.kind].edit,
      });
      return assistantSlot.update(ctx, (state) => {
        const now = waiting(state);
        if (isToolFailure(now)) return now;
        const sent = applyProposal(state, now.email, edited);
        if (isToolFailure(sent)) return sent;
        rememberExample(state, now.email, "email");
        applyReflection(state, updates);
        return { sent, learned: describeUpdates(updates) };
      });
    },
  });
}

/** `ignore` — their `ignore`, and their drafting model's `Ignore` tool: mark it read and move on. */
export function ignoreTool(): ToolDef {
  return reviewFlow.tool({
    description:
      `${name} wants to skip the open email — no reply, no invite. Marks it read and drops ` +
      "anything staged for it. Only when they have said so.",
    when: [DRAFTING, AWAITING],
    send: { type: "SETTLED" },
    execute: (_args, ctx) =>
      assistantSlot.update(ctx, (state) => {
        const email = openEmail(state);
        if (!email) return toolFailure("No email is open — there is nothing to ignore.");
        const dropped = state.proposal ? describeProposal(state.proposal).title : null;
        const closedAs = state.proposal?.kind === "notify" ? "notified" : "ignored";
        state.proposal = null;
        closeEmail(state, email.id, closedAs);
        rememberExample(state, email, "no");
        state.log.push(`Ignored: ${email.subject}`);
        return { ignored: email.subject, dropped, next: "open_email for the next one." };
      }),
  });
}

/** What `respond` hands back to the drafting model, per their four human nodes. */
function respondPlan(proposal: DeepReadonly<Proposal>, feedback: string) {
  switch (proposal.kind) {
    case "question":
      return {
        line: `${name} responded in this way: ${feedback}`,
        instructions: `${name} answered your question. Carry on — draft_reply once you have enough, or ask_question again if not.`,
      };
    case "notify":
      return {
        line: `${name} gave these instructions: ${feedback}`,
        instructions: `Do what ${name} asked with this email: draft_reply, send_calendar_invite, new_email, or ignore.`,
      };
    case "invite":
      return {
        line: `${name} interrupted and gave these instructions: ${feedback}`,
        instructions:
          "Redo it as instructed: send_calendar_invite again with the change, or draft_reply.",
      };
    default:
      return {
        line: `Error, ${name} interrupted and gave this feedback: ${feedback}`,
        instructions: "Redraft with that feedback: call draft_reply again with a new draft.",
      };
  }
}

/**
 * `respond` — their `response`: words for the drafting model, not a decision.
 * The answer to a question, or feedback that sends a draft back for another go.
 */
export function respondTool(): ToolDef {
  return reviewFlow.tool({
    description:
      `${name} answered your question, or gave feedback or instructions instead of a plain ` +
      "yes or no — hand their words back so you can draft again. Not for a yes (accept), " +
      "a dictated replacement (edit), or a skip (ignore).",
    when: AWAITING,
    send: { type: "REDRAFT" },
    inputSchema: z.object({
      feedback: z.string().min(1).max(1000).describe(`What ${name} said, in their words`),
    }),
    async execute(args, ctx) {
      const before = assistantSlot.get(ctx);
      const it = waiting(before);
      if (isToolFailure(it)) return it;
      const denied = requireAllowed(it.proposal, "respond");
      if (denied) return denied;
      const plan = respondPlan(it.proposal, args.feedback);
      const updates = await reflect(ctx.generate, {
        memory: before.memory,
        trajectory: trajectoryOf(before),
        feedback: plan.line,
        promptTypes: REFLECTION_SCOPE[it.proposal.kind].respond,
      });
      return assistantSlot.update(ctx, (state) => {
        const now = waiting(state);
        if (isToolFailure(now)) return now;
        state.proposal = null;
        state.exchange.push(plan.line);
        rememberExample(state, now.email, "email");
        applyReflection(state, updates);
        state.log.push(`${name}: ${args.feedback}`);
        return {
          feedback: plan.line,
          instructions: plan.instructions,
          learned: describeUpdates(updates),
        };
      });
    },
  });
}
