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
    // `lastLine` rather than `streamTail` + `stream` composed here: a progress
    // channel is never closed — no step knows it is the last one — so a stream
    // opened on a run that has written nothing waits forever, which down a phone
    // is a turn that stops with no error and nothing in a log. The bound that
    // prevents it belongs to the method now, and `undefined` is "nothing yet".
    const line = await ctx.workflows.lastLine(latest.runId);
    return line === undefined
      ? { note: "Started, nothing to report yet." }
      : { progress: String(line) };
  },
});
