import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { findMeetingTime } from "../meeting.ts";
import { threadText } from "../prompts.ts";
import { assistantSlot, DRAFTING, openEmail, reviewFlow } from "../shared.ts";

/**
 * Their `MeetingAssistant` → `find_meeting_time`: a specialist reads the
 * calendar and reports the free slots, and the report comes back as this
 * tool's result — their `ToolMessage` back into `draft_response`. The
 * specialist is a subagent (`../meeting.ts`), so the calendar lookups never
 * reach this conversation; what does is one dense sentence.
 *
 * No `send`: the call stays in `drafting`, because knowing the free slots is
 * not yet a proposal. `draft_reply` or `send_calendar_invite` comes next.
 */
export default reviewFlow.tool({
  description:
    `Ask the meeting assistant when ${EXECUTIVE.name} is free, for an email that is trying to ` +
    "set up a meeting. It reads the calendar and answers with the open slots. Say you are " +
    "checking the calendar before you call it — it takes a moment.",
  when: DRAFTING,
  inputSchema: z.object({
    request: z
      .string()
      .min(1)
      .max(300)
      .describe("What the sender is asking for — which days, how long, any times they ruled out"),
  }),
  async execute(args, ctx) {
    const email = openEmail(assistantSlot.get(ctx));
    if (!email) return toolFailure("No email is open — call open_email first.");
    const found = await findMeetingTime(ctx.delegate, threadText(email), args.request);
    return assistantSlot.update(ctx, (state) => {
      state.exchange.push(`Meeting assistant: ${found.availability}`);
      state.log.push(`Checked the calendar (${found.lookups} lookups)`);
      return {
        ...found,
        next:
          "Offer these times in draft_reply, or send_calendar_invite if the meeting should be " +
          "booked outright.",
      };
    });
  },
});
