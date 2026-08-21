import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import type { GameState } from "../shared.ts";
import { gameSlot, loadState, saveSlotKey, saveSlotParam, storyFlow } from "../shared.ts";

// Requires storage — `aai storage enable` (or DATABASE_URL in .env under
// `aai dev`); the rest of the game works without it.
export default tool({
  description: "Load a previously saved game.",
  inputSchema: z.object({ slot: saveSlotParam }),
  async execute(args, ctx) {
    const saved = await loadState<GameState>(ctx, saveSlotKey(args.slot));
    if (!saved) return { error: "No save found." };
    gameSlot.set(ctx, saved);

    // The flow has to be restored alongside the campaign, or a loaded game
    // would still be sitting in `awaitingSetup` with every roll tool refusing.
    // A save is written from a settled scene, so it resumes at `awaitingRoll`
    // rather than with a standing roll — `lastRoll` may be set, but a burn
    // window that survived a save and a reload is not one a player is still in.
    storyFlow.reset(ctx);
    let at = storyFlow.send(ctx, { type: "SETUP" });
    if (saved.gameOver) at = storyFlow.send(ctx, { type: "DOWNED" });

    return {
      loaded: true,
      at: at.state,
      next: at.instruction,
      playerName: saved.playerName,
      characterConcept: saved.characterConcept,
      settingGenre: saved.settingGenre,
      sceneCount: saved.sceneCount,
      currentLocation: saved.currentLocation,
      initialized: saved.initialized,
    };
  },
});
