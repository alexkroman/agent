import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import recap, { SAMPLE_RECORDING } from "../workflows/recap.ts";

export default tool({
  description:
    "Start writing up a recording. Returns immediately; the work continues after the call.",
  inputSchema: z.object({
    url: z.url().optional().describe("The recording, if the caller named one"),
  }),
  execute: async ({ url }, ctx) => {
    // Temporal's workflow-id reuse policy, spelled with what this SDK has: the
    // desk allows ONE live recap per caller, so a caller who asks twice is told
    // about the run they already have instead of paying for a second
    // transcription of the same audio.
    const live = await ctx.workflows.live(recap);
    if (live) return { started: false, runId: live.runId, note: "One is already running for you." };

    const runId = await ctx.workflows.start(
      recap,
      { url: url ?? SAMPLE_RECORDING, requestedBy: ctx.sessionId },
      {
        // When the run settles, this session takes an unprompted turn built
        // from the run's output. The instruction is a sentence for the MODEL —
        // it is the only thing that knows what this caller has been told.
        notify:
          "Tell them the recap is ready, read the one-sentence version, then ask whether " +
          "to keep the transcript on file or delete it.",
      },
    );
    return { started: true, runId };
  },
});
