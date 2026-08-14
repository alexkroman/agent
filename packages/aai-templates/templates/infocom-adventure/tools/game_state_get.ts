import { gameSlot, REPORTED_HISTORY } from "../shared.ts";

export default gameSlot.tool({
  description:
    "Read the current game state including inventory, current room, score, moves, flags, and recent history.",
  execute(_args, game) {
    return {
      currentRoom: game.currentRoom,
      inventory: game.inventory,
      score: game.score,
      moves: game.moves,
      flags: game.flags,
      recentHistory: game.history.slice(-REPORTED_HISTORY),
    };
  },
});
