import { clockTime, requireSessionClient, tool } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { homeTimeZone, MAX_REMINDER_MS, remind, reminderDueAt, spokenDue } from "../shared.ts";

// "Remind me to call the plumber at five." Held by the AGENT, not the speaker, so it outlives
// the session and a restart: a durable run sleeps until it is due, speaks the reminder, and
// pushes the audio to the speaker's inbox socket (workflows/remind.ts). The speaker is found
// by the ?client= id it opened this session with, which is also the id its inbox is held under.

export default tool({
  description:
    "Set a reminder the speaker will say out loud later, e.g. 'remind me to call the " +
    "plumber at five' or 'in twenty minutes, remind me to flip the laundry'. Give exactly " +
    "one of in_seconds or at. Also for a plain countdown ('set a timer for ten minutes'): " +
    "then the text is what it was for, or 'your timer'.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(120)
      .describe("What to remind them of, as a short phrase, e.g. 'call the plumber'"),
    in_seconds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("How long from now, in seconds, when they said a duration"),
    // clockTime states the zero-padding in its description, the half a model gets wrong
    // ("4:45" for quarter to five), and refuses an unpadded time before execute runs.
    at: clockTime("the time of day they said (five pm is 17:00)").optional(),
  }),
  async execute({ text, in_seconds, at }, ctx) {
    // No ?client= id means no inbox to say it on later: refused, not silently dropped.
    const clientId = requireSessionClient(ctx, "This device can't receive reminders.");
    if (isToolFailure(clientId)) return clientId;
    const zone = homeTimeZone(ctx.env);
    const now = new Date();
    const dueAt = reminderDueAt(now, { inSeconds: in_seconds, at }, zone);
    if (dueAt === undefined) return { error: "Say when: a time of day or how long from now." };
    if (dueAt - now.getTime() > MAX_REMINDER_MS) {
      return { error: "Reminders can be at most a week away." };
    }
    const due = spokenDue(now, dueAt, zone);
    // Keyed by the speaker, so cancel_reminders finds every one it set.
    await ctx.workflows.start(
      remind,
      { clientId, text, dueAt },
      { key: clientId, label: `${text} · due ${due}` },
    );
    return { scheduled: true, text, due };
  },
});
