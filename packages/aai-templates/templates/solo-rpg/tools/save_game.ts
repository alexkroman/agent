import type { KV } from "../_shared.ts";
import { getGameState } from "../_shared.ts";

export default async function execute(args: { slot?: string }, ctx: { kv: KV }) {
  const state = await getGameState(ctx.kv);
  await ctx.kv.set(`save:${args.slot ?? "autosave"}`, state);
  return {
    saved: true,
    slot: args.slot ?? "autosave",
    name: state.playerName,
    scene: state.sceneCount,
  };
}
