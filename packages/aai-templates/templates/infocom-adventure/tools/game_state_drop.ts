import { getGameState, saveGameState } from "../_shared.ts";

export const description = "Remove an item from the player's inventory.";

export const parameters = {
  type: "object",
  properties: {
    value: { type: "string", description: "Item name to drop" },
  },
  required: ["value"],
};

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
  g.inventory = g.inventory.filter((i) => i !== args.value);
  await saveGameState(ctx.kv, g);
  return { inventory: g.inventory };
}
