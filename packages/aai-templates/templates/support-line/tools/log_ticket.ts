import { z } from "zod";
import { supportSlot } from "../shared.ts";

/**
 * The exit the grading apparatus needs.
 *
 * A support line that can only answer is a support line that will eventually
 * answer wrong. `exhausted` is a reachable state in the graph precisely so
 * there is somewhere to go from it, and this is that somewhere.
 */
export const logTicket = supportSlot.tool({
  description:
    "Log a callback ticket for a question the knowledge base could not answer. " +
    "Ask for a callback number first, and read the reference back.",
  inputSchema: z.object({
    question: z.string().max(500).describe("What the caller needs answered"),
    callback: z.string().max(40).describe("The number to call them back on"),
  }),
  execute(args, state) {
    state.ticketCounter++;
    const reference = `TCK${String(4000 + state.ticketCounter)}`;
    // The callback number stays in state and never reaches the browser — see
    // `supportView`, which projects the reference alone.
    state.ticket = { reference, question: args.question, callback: args.callback };
    return {
      reference,
      message: `Ticket ${reference} logged. Read the reference back to the caller.`,
    };
  },
});
