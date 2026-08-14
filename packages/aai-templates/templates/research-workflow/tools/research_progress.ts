import { tool } from "@alexkroman1/aai";
import { research } from "../shared.ts";

export default tool({
  description: "Say what the research is doing right now, for a run that has not finished yet.",
  execute: async (_args, ctx) => {
    const [latest] = await ctx.workflows.find(research, ctx.sessionId, { limit: 1 });
    if (!latest) return { note: "Nothing started yet." };
    // `research_status` reports the run's STATUS; this reports what the run
    // has WRITTEN (`getWritable()` in `workflows/research.ts`). Between "still
    // working on it" and a finished summary there is otherwise nothing to say.
    //
    // `streamTail` FIRST, and not as an optimization: a progress channel is
    // never closed — no step knows it is the last one — so reading a stream
    // with nothing in it waits forever rather than ending. `-1` is "nothing
    // written yet", and it is the only safe way to learn that.
    if ((await ctx.workflows.streamTail(latest.runId)) < 0) {
      return { note: "Started, nothing to report yet." };
    }
    // A negative `startIndex` reads from the END, which is what a voice reply
    // wants — the last line, not a recital of the whole log.
    const stream = await ctx.workflows.stream(latest.runId, { startIndex: -1 });
    for await (const line of stream) return { progress: String(line) };
    return { note: "Started, nothing to report yet." };
  },
});
