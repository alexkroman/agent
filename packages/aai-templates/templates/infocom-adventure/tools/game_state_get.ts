import { getGameState } from "../_shared.ts";

export const description =
  "Read the current game state including inventory, current room, score, moves, flags, and recent history.";

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
