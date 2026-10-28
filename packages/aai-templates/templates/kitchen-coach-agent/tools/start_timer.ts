import { clientTool } from "@alexkroman1/aai";
import { z } from "zod";
import { MAX_TIMER_MINUTES } from "../shared.ts";

/**
 * Start a kitchen timer ON THE PAGE. The countdown and the chime are the browser's: a
 * timer must ring whether or not anyone is talking, and a session that ends must not take
 * it along. The page's handler is `startTimer` (shared.ts) plus a setState, and what it
 * returns — `{ started, label, minutes }` or `{ error }` — is what the model reads.
 */
export default clientTool({
  description:
    "Start a kitchen timer on the cook's screen, e.g. 'set a timer for the pasta, nine " +
    "minutes'. It chimes there when it is done. Use one timer per thing being timed.",
  ui: { icon: "⏲️", label: "Starting a timer" },
  inputSchema: z.object({
    label: z.string().max(40).describe("What it is for, in a word or two, e.g. 'pasta'"),
    minutes: z
      .number()
      .positive()
      .max(MAX_TIMER_MINUTES)
      .describe("How long, in minutes; 0.5 for thirty seconds"),
  }),
});
