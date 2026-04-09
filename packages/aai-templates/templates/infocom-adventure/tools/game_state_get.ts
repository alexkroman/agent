import { getGameState } from "../_shared.ts";

export default async function execute(
  _args: unknown,
  ctx: { kv: { get: <T>(key: string) => Promise<T | null> } },
) {
  const g = await getGameState(ctx.kv);
  return {
    currentRoom: g.currentRoom,
    inventory: g.inventory,
    score: g.score,
    moves: g.moves,
    flags: g.flags,
    recentHistory: g.history.slice(-5),
  };
}
