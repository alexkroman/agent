import { z } from "zod";
import { BEFORE_TRANSFER, retailTool } from "../store.ts";

export default retailTool({
  name: "transfer_to_human_agents",
  description:
    "Hand the caller to a human agent. Use this ONLY when the caller explicitly asks for a human, " +
    "or when their request cannot be handled with the other tools and the policy. The caller is " +
    "transferred by THIS CALL and by nothing else: call it before you say anything about a " +
    "transfer, and never say 'You are being transferred' until it has answered. Once it has, say " +
    "'You are being transferred to a human agent. Please hold on.' and nothing else.",
  inputSchema: z.object({
    summary: z.string().max(2000).describe("A short summary of the caller's issue for the human"),
  }),
  // Legal before the handoff from either side: someone who cannot be identified
  // is exactly who needs a human, and blocking the escape hatch behind an auth
  // gate would trap them. `TRANSFERRED` is the one transition into the terminal
  // state, which is what makes "say nothing else after this" enforced rather
  // than asked for — every tool, this one included, refuses afterwards.
  when: BEFORE_TRANSFER,
  send: { type: "TRANSFERRED" },
  summary: () => "transferred to a human agent",
  execute: (args) => ({
    transferred: true,
    summary: args.summary,
    message: "Transfer successful.",
  }),
});
