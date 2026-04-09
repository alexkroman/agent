import type { KV } from "../_shared.ts";
import { getGameState } from "../_shared.ts";

export default async function onUserTranscript(_text: string, ctx: { kv: KV }) {
  // Auto-save after every turn so progress persists across browser refreshes.
  const state = await getGameState(ctx.kv);
  if (state.initialized) {
    await ctx.kv.set("save:game", state);
  }
}
