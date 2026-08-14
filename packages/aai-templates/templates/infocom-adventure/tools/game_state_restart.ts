import { gameSlot } from "../shared.ts";

export default gameSlot.tool({
  description:
    "Reset the game to the beginning: empty inventory, zero score and moves, all flags cleared. Use when the player asks to restart, quit, or start a new game.",
  // The one tool here that does NOT want the live value: it replaces it. The
  // slot is still what defines the tool, so the state type comes from the same
  // place as every sibling's rather than from an annotation on `ctx`.
  execute(_args, _game, ctx) {
    const fresh = gameSlot.reset(ctx);
    return { restarted: true, currentRoom: fresh.currentRoom };
  },
});
