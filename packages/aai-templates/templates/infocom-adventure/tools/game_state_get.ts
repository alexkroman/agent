import { gameSlot, REPORTED_HISTORY, statusLine } from "../shared.ts";

export default gameSlot.tool({
  description:
    "Read the current game state including inventory, current room, score, rank, moves, flags, and recent history.",
  execute(_args, game) {
    return {
      // The same four fields the CRT's top bar gets through `syncState`, built
      // by the same function — so what the narrator is told and what the player
      // can read off the screen cannot drift.
      ...statusLine(game),
      inventory: game.inventory,
      flags: game.flags,
      recentHistory: game.history.slice(-REPORTED_HISTORY),
    };
  },
});
