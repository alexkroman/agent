import { isTerminal, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { recap, SAMPLE_RECORDING } from "../shared.ts";

export default tool({
  description:
    "Start writing up a recording. Returns immediately; the work continues after the call.",
  inputSchema: z.object({
    url: z.url().optional().describe("The recording, if the caller named one"),
  }),
  execute: async ({ url }, ctx) => {
    // Temporal's workflow-id reuse policy, spelled with what this SDK has:
    // the desk allows ONE live recap per caller, so a caller who asks twice
    // is told about the run they already have instead of paying for a second
    // transcription of the same audio. `find` searches the correlation-key
    // index — the same key `start` writes below.
    const [live] = await ctx.workflows.find(recap, ctx.sessionId, { limit: 1 });
    if (live && !isTerminal(live)) {
      return { started: false, runId: live.runId, note: "One is already running for you." };
    }

    const runId = await ctx.workflows.start(
      recap,
      { url: url ?? SAMPLE_RECORDING, requestedBy: ctx.sessionId },
      {
        // The durable handle. A `runId` kept in `ctx.state` would be swept
        // shortly after the caller hangs up, while the run outlives the
        // call — so the key is what a later turn (or a later call) finds it
        // by. `ctx.sessionId` keys THIS call; a real desk keys on the
        // caller's number, and nothing else changes.
        key: ctx.sessionId,
        // What makes "I'll let you know" true: when the run settles, this
        // session takes an unprompted, interruptible turn built from the
        // run's own output. The instruction is a sentence for the MODEL —
        // it is the only thing that knows what this caller has been told.
        notify:
          "Tell them the recap is ready, read the one-sentence version, then ask whether " +
          "to keep the transcript on file or delete it.",
      },
    );
    return { started: true, runId };
  },
});
