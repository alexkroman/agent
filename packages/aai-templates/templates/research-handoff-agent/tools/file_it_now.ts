import { tool } from "@alexkroman1/aai";
import research from "../workflows/research.ts";

export default tool({
  description:
    "Skip the review wait on the research and file it immediately. Use when the caller says they need it now.",
  execute: async (_args, ctx) => {
    const live = await ctx.workflows.live(research);
    if (!live) return { filed: false, note: "Nothing is in flight to file." };
    // Wakes THE REVIEW WAIT by its label rather than every suspension the run
    // holds, so "send it now" cannot also end an approval window a later body
    // might open. `0` is an honest answer: the run had already moved past it.
    const woken = await ctx.workflows.wakeUp(live.runId, { correlationIds: ["reviewWindow"] });
    return woken > 0
      ? { filed: true, note: "Filing it now." }
      : { filed: false, note: "That one was not waiting — it has already moved on." };
  },
});
