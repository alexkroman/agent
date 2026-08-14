import { z } from "zod";
import { retailTool } from "../store.ts";

export default retailTool({
  name: "transfer_to_human_agents",
  description:
    "Hand the caller to a human agent. Use this ONLY when the caller explicitly asks for a human, " +
    "or when their request cannot be handled with the other tools and the policy. Call this FIRST, " +
    "then say 'You are being transferred to a human agent. Please hold on.' and nothing else.",
  inputSchema: z.object({
    summary: z.string().max(2000).describe("A short summary of the caller's issue for the human"),
  }),
  // No authentication: someone who cannot be identified is exactly who needs a
  // human, and blocking the escape hatch behind the gate would trap them.
  requiresAuth: false,
  summary: () => "transferred to a human agent",
  execute: (args) => ({
    transferred: true,
    summary: args.summary,
    message: "Transfer successful.",
  }),
});
