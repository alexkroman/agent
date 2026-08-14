import { tool } from "@alexkroman1/aai";
import { recap } from "../shared.ts";

export default tool({
  description: "Say what the transcription is doing right now, for a run still in flight.",
  execute: async (_args, ctx) => {
    const [latest] = await ctx.workflows.find(recap, ctx.sessionId, { limit: 1 });
    if (!latest) return { note: "Nothing started yet." };
    // `recap_status` reports the run's STATUS; this reports what the run has
    // WRITTEN. Between "still working on it" and a finished recap there is
    // otherwise nothing to say — and this run has real news in between,
    // since every poll narrates.
    //
    // `streamTail` FIRST, and not as an optimization: a progress channel is
    // never closed — no step knows it is the last one — so reading a stream
    // with nothing in it waits forever rather than ending. `-1` is "nothing
    // written yet", and it is the only safe way to learn that.
    if ((await ctx.workflows.streamTail(latest.runId)) < 0) {
      return { note: "Submitted, nothing to report yet." };
    }
    // A negative `startIndex` reads from the END, which is what a voice
    // reply wants — the last line, not a recital of the whole log.
    const stream = await ctx.workflows.stream(latest.runId, { startIndex: -1 });
    for await (const line of stream) return { progress: String(line) };
    return { note: "Submitted, nothing to report yet." };
  },
});
