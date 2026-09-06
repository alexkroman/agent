import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { propose } from "../review.ts";
import { assistantSlot, DRAFTING, reviewFlow } from "../shared.ts";

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * Their `SendCalendarInvite` → `send_cal_invite`: staged, read back, and sent
 * by `accept` alone. Their schema's own warning rides on the field: "Do NOT
 * make any emails up!"
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
    startTime: z
      .string()
      .regex(LOCAL_DATETIME, "2026-03-17T14:00:00")
      .describe(`Start, local to ${EXECUTIVE.timezone}, like 2026-03-17T14:00:00`),
    endTime: z.string().regex(LOCAL_DATETIME, "2026-03-17T14:30:00").describe("End, same format"),
  }),
  execute: (args, ctx) => {
    if (args.endTime <= args.startTime) {
      return toolFailure("The meeting ends before it starts — check the times.");
    }
    return assistantSlot.update(ctx, (state) =>
      propose(state, {
        kind: "invite",
        emails: [...args.emails],
        title: args.title,
        startTime: args.startTime,
        endTime: args.endTime,
      }),
    );
  },
});
