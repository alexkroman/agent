import { getGameState, saveGameState } from "../_shared.ts";

export default async function execute(
  args: { value: string },
  ctx: {
    kv: {
      get: <T>(key: string) => Promise<T | null>;
      set: (key: string, value: unknown) => Promise<void>;
    };
  },
) {
  const g = await getGameState(ctx.kv);
  g.currentRoom = args.value;
  g.moves++;
  await saveGameState(ctx.kv, g);
  return { currentRoom: g.currentRoom, moves: g.moves };
}
