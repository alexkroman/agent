import { sessionClientId, sessionClientPhone, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { research } from "../shared.ts";

// "Do some deep research on heat pumps for an old house." Minutes of work, so it can't
// happen in this conversation: this starts a durable run (workflows/research.ts) and
// answers now. The run says a summary on the speaker when it is done, and texts the
// report to the session's phone (the one the client reported, else SMS_TO_PHONE) only
// when they asked for a text: nothing is texted unasked.
export default tool({
  description:
    "Start a deep research job that takes a few minutes: several searches and pages " +
    "read, then a written report. Use it when they ask you to research, look into, " +
    "dig into, or compare something in depth, not for a quick fact you can search " +
    "now. The speaker says the results when it's done. Set text only when they asked " +
    "for the report to be texted.",
  inputSchema: z.object({
    topic: z
      .string()
      .min(3)
      .max(1000)
      .describe(
        "What to research, with every detail they gave, e.g. 'heat pumps for a 1920s house in Portland'",
      ),
    text: z
      .boolean()
      .optional()
      .describe("True only if they asked to be texted the report; else it is only said"),
  }),
  async execute({ topic, text = false }, ctx) {
    const clientId = sessionClientId(ctx);
    // A session with no ?client= has no speaker to say it on, and a text they didn't ask
    // for is the one thing this must not do: ask instead.
    if (!(clientId || text)) {
      return toolFailure(
        "There's no speaker here to say the results on. Ask whether to text them the report.",
      );
    }
    const phone = sessionClientPhone(ctx);
    await ctx.workflows.start(
      research,
      { topic, clientId, phone, text },
      clientId ? { key: clientId, label: topic } : { label: topic },
    );
    return {
      started: true,
      // What the model can promise: the speaker only announces to a speaker.
      delivery: !clientId
        ? "texted"
        : text
          ? "said on the speaker, and texted"
          : "said on the speaker",
    };
  },
});
