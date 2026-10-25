import { gameSlot } from "../shared.ts";

export default gameSlot.tool({
  description:
    "Reset the game to the beginning: empty inventory, zero score and moves, all flags cleared. Use when the player asks to restart, quit, or start a new game.",
  // The one tool that does not want the live value: it replaces it.
  execute(_args, _game, ctx) {
    const fresh = gameSlot.reset(ctx);
    return { restarted: true, currentRoom: fresh.currentRoom };
  },
});
