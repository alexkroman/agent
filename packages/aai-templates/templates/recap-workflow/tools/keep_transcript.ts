import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { retentionToken } from "../workflows/tokens.ts";

export default tool({
  description:
    "Answer the desk's question about the transcript. Use when the caller says to keep it, save it, or delete it.",
  inputSchema: z.object({
    keep: z.boolean().describe("True to keep the transcript on file, false to delete it"),
  }),
  execute: async ({ keep }, ctx) => {
    // The SIGNAL, and the whole reason this template exists in the shape it
    // does. The run is parked on a hook whose token both sides derive from
    // the session — see `workflows/tokens.ts` — so the tool needs no runId
    // and no bookkeeping of its own.
    const delivered = await ctx.workflows.signal(retentionToken(ctx.sessionId), { keep });
    // `false` is the ORDINARY answer, not a failure: the window closed, or
    // the caller answered a question nobody asked. Say which.
    if (!delivered) {
      return {
        answered: false,
        note: "Nothing is waiting on that — it has already been settled.",
      };
    }
    return {
      answered: true,
      keep,
      note: keep ? "Keeping the transcript on file." : "Deleting the transcript.",
    };
  },
});
