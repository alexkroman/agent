import type { GameState, KV } from "../_shared.ts";
import { saveGameState } from "../_shared.ts";

export default async function onConnect(ctx: { kv: KV }) {
  // Auto-load saved game on connect (restores game state from KV).
  const saved = await ctx.kv.get<GameState>("save:game");
  if (saved) {
    await saveGameState(ctx.kv, saved);
  }
}
