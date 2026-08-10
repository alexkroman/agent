import { tool } from "@alexkroman1/aai";
import { gameSlot, stateSummary } from "../shared.ts";

export const checkState = tool({
  description:
    "Returns the full current game state. Call this at the start of every turn, before narrating or rolling, and treat the returned values as ground truth — never guess or remember stats from previous turns.",
  async execute(_args, ctx) {
    const state = gameSlot.get(ctx);
    return stateSummary(state);
  },
});
