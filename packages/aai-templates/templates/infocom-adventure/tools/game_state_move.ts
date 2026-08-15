import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.updateTool({
  description: "Move the player to a new room and increment the move counter.",
  inputSchema: z.object({
    value: z.string().describe("Room name to move to"),
  }),
  execute(args, game) {
    game.currentRoom = args.value;
    game.moves++;
    return { currentRoom: game.currentRoom, moves: game.moves };
  },
});
