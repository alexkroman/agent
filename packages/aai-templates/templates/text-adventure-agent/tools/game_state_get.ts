import { gameSlot } from "../shared.ts";

export default gameSlot.tool({
  description:
    "Read the current game state including inventory, current room, score, rank, moves and flags.",
  execute(_args, game) {
    // The same four fields the CRT's top bar shows, built by the same view.
    return { ...gameSlot.projected(game), inventory: game.inventory, flags: game.flags };
  },
});
