import { clockTime, isoDate, spokenDate, spokenTime, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { clashOn } from "../meeting.ts";
import { propose } from "../review.ts";
import { assistantSlot, DRAFTING, reviewFlow } from "../shared.ts";

/**
 * Their `SendCalendarInvite` → `send_cal_invite`: staged, read back, and sent
 * by `accept` alone. Their schema's own warning rides on the field: "Do NOT
 * make any emails up!"
 *
 * **The day and the two times are three CIVIL fields**, not one ISO datetime.
 * The pair of regexes that shape used to carry accepted `2026-02-30T99:99` —
 * both halves are checked now, by the same predicates the SDK's date and clock
 * fields put in front of the model as JSON Schema, so a bad value is refused
 * before `execute` runs rather than by a sentence written here. It also makes
 * the read-back speakable: `2026-03-17T14:00:00` is what a TTS engine spells
 * out digit by digit.
 *
 * **And the calendar is CHECKED.** The description asks for `meeting_assistant`
 * first, and a rule the model can skip is not a rule (see `retail-orders-agent`'s
 * confirmation gate): a slot the calendar already holds is refused here, naming
 * what is in it, so the one tool that books time in the executive's name cannot
 * double-book them because a model went straight to it.
 */
export default reviewFlow.tool({
  description:
    `Book a meeting on ${EXECUTIVE.name}'s calendar and invite the people on the thread. Only ` +
    "once you are sure they want it and meeting_assistant has said the slot is free. Staged " +
    "for read-back, not sent.",
  when: DRAFTING,
  send: { type: "PROPOSED" },
  inputSchema: z.object({
    emails: z
      .array(z.string().max(120))
      .min(1)
      .max(10)
      .describe("Who to invite. Do NOT make any emails up!"),
    title: z.string().min(1).max(120).describe("Name of the meeting"),
    date: isoDate("the day of the meeting"),
    startTime: clockTime(`when it starts, 24-hour, local to ${EXECUTIVE.timezone}`),
    endTime: clockTime("when it ends, same format"),
  }),
  execute: (args, ctx) => {
    if (args.endTime <= args.startTime) {
      return toolFailure("The meeting ends before it starts — check the times.");
    }
    const clash = clashOn(args.date, args.startTime, args.endTime);
    if (clash) {
      return toolFailure(
        `${EXECUTIVE.name} already has "${clash.title}" on ${spokenDate(args.date)} from ` +
          `${spokenTime(clash.start)} to ${spokenTime(clash.end)}. Ask meeting_assistant for a ` +
          "free slot and offer that instead.",
      );
    }
    return assistantSlot.update(ctx, (state) =>
      propose(state, {
        kind: "invite",
        emails: [...args.emails],
        title: args.title,
        date: args.date,
        startTime: args.startTime,
        endTime: args.endTime,
      }),
    );
  },
});
