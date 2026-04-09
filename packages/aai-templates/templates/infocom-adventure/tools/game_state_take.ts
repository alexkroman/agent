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
  if (!g.inventory.includes(args.value)) g.inventory.push(args.value);
  await saveGameState(ctx.kv, g);
  return { inventory: g.inventory };
}
