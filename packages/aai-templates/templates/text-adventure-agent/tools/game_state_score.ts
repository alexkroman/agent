import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.updateTool({
  description:
    "Add points to the player's score. Answers with the new total and the player's rank.",
  inputSchema: z.object({
    value: z.number().describe("Points to add"),
  }),
  execute(args, game) {
    game.score += args.value;
    return { score: game.score };
  },
  // The rank is read off the STORED game, after the slot's `after` hook has
  // moved it — the turn a rank changes on is the one the narrator announces.
  report: (stored, partial) => ({ ...partial, rank: stored.rank }),
});
