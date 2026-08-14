import { z } from "zod";
import { gameSlot, REPORTED_HISTORY, recordCommand } from "../shared.ts";

export default gameSlot.tool({
  description: "Log a player command to the history and increment the move counter.",
  inputSchema: z.object({
    value: z.string().describe("Command text to log"),
  }),
  execute(args, game) {
    recordCommand(game, args.value);
    game.moves++;
    return { moves: game.moves, recentHistory: game.history.slice(-REPORTED_HISTORY) };
  },
});
