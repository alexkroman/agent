// Copyright 2026 the AAI authors. MIT license.
/**
 * Hang up — once the task is done, the callee has said goodbye, or a voicemail
 * message has been left.
 *
 * `endSession` lets the current reply finish speaking first, so the goodbye the
 * model writes alongside this call is heard before the line drops. A hang-up
 * after a voicemail message says so, and the session records it
 * (`voicemailSlot`) for `onSessionEnd` to hand the run.
 */

import { endSession, tool, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";
import { voicemailSlot } from "../shared.ts";

export default tool({
  description:
    "Hang up the call, in the same reply as your goodbye — a silent hang-up sounds like a " +
    "dropped line. Call it once the task is finished or they say goodbye, and in the same " +
    "reply as a voicemail message. Not right after answering one of their questions.",
  inputSchema: z.object({
    voicemail: z
      .boolean()
      .optional()
      .describe("True when you are hanging up after leaving a message on voicemail"),
  }),
  execute({ voicemail }, ctx) {
    if (voicemail === true) voicemailSlot.set(ctx, true);
    return withInstruction(
      { ended: endSession(ctx) },
      "Finish your last sentence; the line closes after it.",
    );
  },
});
