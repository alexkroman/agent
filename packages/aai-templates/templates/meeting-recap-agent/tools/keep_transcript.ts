import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import recap from "../workflows/recap.ts";

export default tool({
  description:
    "Answer the desk's question about the transcript. Use when the caller says to keep it, save it, or delete it.",
  inputSchema: z.object({
    keep: z.boolean().describe("True to keep the transcript on file, false to delete it"),
  }),
  execute: async ({ keep }, ctx) => {
    // The SIGNAL — the caller is the approver and the phone is the signal
    // channel. The run is parked on `ctx.waitForSignal("retention")`, keyed by
    // the session it was started from, so `signalRun` addresses it by the def,
    // the session's key and the label: no runId, no token, no bookkeeping.
    const delivered = await ctx.workflows.signalRun(recap, "session", "retention", { keep });
    // `false` is the ORDINARY answer, not a failure: the window closed, or the
    // caller answered a question nobody asked.
    if (!delivered) {
      return { answered: false, note: "Nothing is waiting on that — it has already been settled." };
    }
    return {
      answered: true,
      keep,
      note: keep ? "Keeping the transcript on file." : "Deleting the transcript.",
    };
  },
});
