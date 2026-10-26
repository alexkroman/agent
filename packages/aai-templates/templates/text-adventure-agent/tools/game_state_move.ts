import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.updateTool({
  description: "Move the player to a new room.",
  inputSchema: z.object({
    value: z.string().describe("Room name to move to"),
  }),
  execute(args, game) {
    game.currentRoom = args.value;
    return { currentRoom: game.currentRoom, moves: game.moves };
  },
});
