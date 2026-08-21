import { z } from "zod";
import { BEFORE_TRANSFER, retailTool } from "../store.ts";

export default retailTool({
  name: "transfer_to_human_agents",
  description:
    "Hand the caller to a human agent. Use this ONLY when the caller explicitly asks for a human, " +
    "or when their request cannot be handled with the other tools and the policy. Call this FIRST, " +
    "then say 'You are being transferred to a human agent. Please hold on.' and nothing else.",
  inputSchema: z.object({
    summary: z.string().max(2000).describe("A short summary of the caller's issue for the human"),
  }),
  // Legal before the handoff from either side: someone who cannot be identified
  // is exactly who needs a human, and blocking the escape hatch behind an auth
  // gate would trap them.
  when: BEFORE_TRANSFER,
  summary: () => "transferred to a human agent",
  // Setting the FIELD is what makes "say nothing else after this" enforced
  // rather than asked for: `callFlow` derives `transferred` from it, so every
  // tool — this one included — refuses from here on. It used to be a
  // `send: { type: "TRANSFERRED" }` beside a `transferred: true` that was only
  // ever part of the RESULT, so the store itself never recorded the handoff.
  execute: (args, state) => {
    state.transferred = true;
    return { transferred: true, summary: args.summary, message: "Transfer successful." };
  },
});
