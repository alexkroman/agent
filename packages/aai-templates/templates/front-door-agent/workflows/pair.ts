import { workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { CLIENT_ID, PAIR_WINDOW_MS } from "../shared.ts";

// A phone waiting to be linked. Started by POST /api/pair under the HASH of the code the
// phone shows (never the code), it waits for the door's link_phone to signal `linked`
// with the door's id, or gives up when the window closes. The phone reads the outcome
// through GET /api/pair/:runId; the phone id rides along so that route shows it only to
// the phone that asked.

const pairInput = z.object({ phoneId: z.string().regex(CLIENT_ID) });

/** Who the door says it is. A payload is untrusted, so it is checked, not cast. */
const linkedSignal = z.object({ doorId: z.string().regex(CLIENT_ID) });

export default workflow({
  description: "Wait for a door to hear this phone's pairing code",
  input: pairInput,
  run: async (input, ctx) => {
    const signal = await ctx.waitForSignal("linked", {
      timeoutMs: PAIR_WINDOW_MS,
      schema: linkedSignal,
    });
    return signal === undefined
      ? { linked: false as const, phoneId: input.phoneId }
      : { linked: true as const, phoneId: input.phoneId, doorId: signal.doorId };
  },
});
