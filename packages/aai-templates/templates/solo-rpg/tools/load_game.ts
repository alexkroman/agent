import type { GameState, KV } from "../_shared.ts";
import { saveGameState } from "../_shared.ts";

export const description = "Load a previously saved game.";

export const parameters = {
  type: "object",
  properties: {
    slot: { type: "string", description: "Save slot name, defaults to autosave" },
  },
};

export default async function execute(args: { slot?: string }, ctx: { kv: KV }) {
  const saved = await ctx.kv.get<GameState>(`save:${args.slot ?? "autosave"}`);
  if (!saved) return { error: "No save found." };
  await saveGameState(ctx.kv, saved);
  return {
    loaded: true,
    playerName: saved.playerName,
    characterConcept: saved.characterConcept,
    settingGenre: saved.settingGenre,
    sceneCount: saved.sceneCount,
    currentLocation: saved.currentLocation,
    initialized: saved.initialized,
  };
}
