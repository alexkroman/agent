import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { research } from "../shared.ts";

export default tool({
  description: "Start researching a topic. Returns immediately; the work continues after the call.",
  inputSchema: z.object({ topic: z.string().min(3) }),
  execute: async ({ topic }, ctx) => {
    // The definition, not the string "research": that types `topic` against
    // the workflow's own schema. `key` is what `research_status` searches on.
    const runId = await ctx.workflows.start(
      research,
      { topic, requestedBy: ctx.sessionId },
      {
        key: ctx.sessionId,
        // What makes "I'll let you know" true. The run finishes minutes
        // later, with no turn to land in — so the SDK gives the agent one:
        // when it settles, this session takes an unprompted turn built from
        // the run's own output, and the caller hears the answer without
        // having to think to ask again.
        //
        // The instruction is a sentence for the MODEL, not a line to read:
        // it is the only thing that knows what this caller has already been
        // told. Omit it (`notify: true`) for the SDK's default.
        //
        // `key` is still the durable handle: an announcement only reaches
        // THIS call, and a run outlives it.
        notify: "Tell them the research came back, then read the summary in one sentence.",
      },
    );
    return { started: true, runId, topic };
  },
});
