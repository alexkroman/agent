// Copyright 2026 the AAI authors. MIT license.
/**
 * Hang up — once the task is done, the callee has said goodbye, or a voicemail
 * message has been left.
 *
 * `endSession` lets the current reply finish speaking first, so the goodbye the
 * model writes alongside this call is heard before the line drops.
 */

import { endSession, tool, withInstruction } from "@alexkroman1/aai";

export default tool({
  description:
    "Hang up the call, in the same reply as your goodbye — a silent hang-up sounds like a " +
    "dropped line. Call it once the task is finished or they say goodbye, and in the same " +
    "reply as a voicemail message. Not right after answering one of their questions.",
  execute(_args, ctx) {
    return withInstruction(
      { ended: endSession(ctx) },
      "Finish your last sentence; the line closes after it.",
    );
  },
});
