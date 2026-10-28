import { requireSessionClient, tool } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import announce from "../workflows/announce.ts";

// A visitor's message for the owner. The run (workflows/announce.ts) delivers it to the
// door's linked phone, and keeps trying until the phone takes it; this answers at once so
// the visitor hears it was passed on. The arguments are also what the day's digest reads
// back out of the door's log, so a message is never stored twice.

export default tool({
  effect: "write",
  description:
    "Pass a visitor's message to the owner's phone. Use it once you know who they are and " +
    "what they want to say, e.g. a delivery, a neighbour, a friend dropping by.",
  ui: { icon: "\u{1F4E8}", label: "Passing it on" },
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(60)
      .describe("Who they are, as they said, e.g. 'Sam from next door'"),
    message: z
      .string()
      .min(1)
      .max(280)
      .describe("The message, in their words, tidied only for punctuation"),
  }),
  async execute({ name, message }, ctx) {
    const doorId = requireSessionClient(ctx, "This door isn't set up to pass on messages.");
    if (isToolFailure(doorId)) return doorId;
    await ctx.workflows.start(
      announce,
      { doorId, notice: { kind: "visitor", name, message } },
      { key: doorId, label: `Message from ${name}` },
    );
    return { passed_on: true };
  },
});
