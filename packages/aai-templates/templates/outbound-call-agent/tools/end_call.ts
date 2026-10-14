// Copyright 2026 the AAI authors. MIT license.
/**
 * Hang up — once the task is done, the callee has said goodbye, or a voicemail
 * message has been left.
 *
 * `endSession` lets the current reply finish speaking first, so the goodbye the
 * model writes alongside this call is heard before the line drops. Saying
 * whether it was VOICEMAIL is the one fact about the call only the agent can
 * judge, so it is recorded here and reported as the call's `outcome`.
 */

import { endSession, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { markVoicemail } from "../live-calls.ts";

export default tool({
  description:
    "Hang up the call. Call it once the task is finished and you have said goodbye, " +
    "or right after leaving a voicemail message.",
  inputSchema: z.object({
    reached: z
      .enum(["person", "voicemail"])
      .describe("Who you ended up talking to: a person, or an answering machine / voicemail"),
  }),
  execute({ reached }, ctx) {
    if (reached === "voicemail") markVoicemail(ctx.sessionId);
    const ending = endSession(ctx);
    return { ended: ending, say: "Finish your last sentence; the line closes after it." };
  },
});
