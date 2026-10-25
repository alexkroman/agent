import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import research from "../workflows/research.ts";

export default tool({
  description: "Start researching a topic. Returns immediately; the work continues after the call.",
  inputSchema: z.object({ topic: z.string().min(3) }),
  execute: async ({ topic }, ctx) => {
    // The definition, not the string "research": that types `topic` against the
    // workflow's own schema. The run is keyed by this session by default, which
    // is what the run builtins and `file_it_now` look it up by.
    const runId = await ctx.workflows.start(
      research,
      { topic, requestedBy: ctx.sessionId },
      {
        // The run finishes minutes later, with no turn to land in — so the
        // session takes one, built from the run's output. The instruction is a
        // sentence for the MODEL: it alone knows what this caller has been told.
        notify: "Tell them the research came back, then read the summary in one sentence.",
      },
    );
    return { started: true, runId, topic };
  },
});
