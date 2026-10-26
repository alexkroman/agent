import { withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { findMeetingTime } from "../meeting.ts";
import { openThread, requireOpenEmail } from "../review.ts";
import { assistantSlot, DRAFTING, reviewFlow } from "../shared.ts";

/**
 * Their `MeetingAssistant` → `find_meeting_time`: a subagent reads the
 * calendar and reports the free slots, and the report comes back as this
 * tool's result — their `ToolMessage` back into `draft_response`. The
 * subagent lives in `../meeting.ts`, so the calendar lookups never
 * reach this conversation; what does is one dense sentence.
 *
 * No `send`: the call stays in `drafting`, because knowing the free slots is
 * not yet a proposal. `draft_reply` or `send_calendar_invite` comes next.
 *
 * A report the subagent's guardrail never accepted is handed on anyway, with
 * `usable: false` and a different instruction — the desk is on a live call and
 * there IS an answer, so a `ToolFailure` would throw away the one thing it
 * learned.
 */
export default assistantSlot.updateTool({
  description:
    `Ask the meeting assistant when ${EXECUTIVE.name} is free, for an email that is trying to ` +
    "set up a meeting. It reads the calendar and answers with the open slots. Say you are " +
    "checking the calendar before you call it — it takes a moment.",
  ui: { icon: "\u{1F4C5}", label: "Checking the calendar" },
  dialog: reviewFlow,
  when: DRAFTING,
  inputSchema: z.object({
    request: z
      .string()
      .min(1)
      .max(300)
      .describe("What the sender is asking for — which days, how long, any times they ruled out"),
  }),
  require: requireOpenEmail,
  prepare: (args, state, ctx) => findMeetingTime(ctx.delegate, openThread(state), args.request),
  execute: (_args, state, found) => {
    state.exchange.push(`Meeting assistant: ${found.availability}`);
    state.log.push(`Checked the calendar (${found.lookups} lookups)`);
    return withInstruction(
      found,
      found.usable
        ? "Offer these times in draft_reply, or send_calendar_invite if the meeting should be " +
            "booked outright."
        : `The assistant did not name a time, so there is nothing to offer. Ask ${EXECUTIVE.name} ` +
            "what to do, or ask again with the days the sender suggested. Do not invent a slot.",
    );
  },
});
