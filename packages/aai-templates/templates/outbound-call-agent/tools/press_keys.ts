// Copyright 2026 the AAI authors. MIT license.
/**
 * Press keys on the phone keypad — how the caller gets through an automated
 * menu ("press 1 for appointments") or types an extension.
 *
 * `sendDtmf` plays each key's tone pair into the call's audio, behind anything
 * the agent is still saying, and the carrier carries it to the menu like the
 * agent's voice. Each press is also written into the call's transcript, so the
 * record shows how the menu was navigated and the summary can say so.
 *
 * A barge-in drops tones not yet played, as it does speech — and a menu talks
 * over everything — so the prompt has the model press keys in a turn that
 * says nothing.
 */

import { tool } from "@alexkroman1/aai";
import { sendDtmf } from "@alexkroman1/aai/experimental";
import { z } from "zod";
import { recordTurn } from "../live-calls.ts";

export default tool({
  description:
    "Press keys on the phone keypad to answer an automated phone menu or enter an " +
    "extension. Call it without saying anything in the same turn. After a press, stay " +
    "silent only while menus keep speaking: the moment a PERSON answers (a name, " +
    '"how can I help you?", "how may I direct your call?"), greet them and say who you ' +
    "are calling for and why.",
  inputSchema: z.object({
    keys: z
      .string()
      .describe(
        "The keys to press, in order: 0-9, * and #. Use w for a half-second pause " +
          "(e.g. '1', '3#', '1234#', '0w2').",
      ),
  }),
  execute({ keys }, ctx) {
    if (!sendDtmf(ctx, keys)) return { pressed: null, error: "The call has ended." };
    recordTurn(ctx.sessionId, "agent", `[pressed ${keys}]`);
    return {
      pressed: keys,
      next: "Wait silently for the next menu. If a person or a question answers instead, speak.",
    };
  },
});
