import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.tool({
  description: "Add points to the player's score.",
  inputSchema: z.object({
    value: z.number().describe("Points to add"),
  }),
  execute(args, game) {
    game.score += args.value;
    return { score: game.score };
  },
});
