import { getGameState, saveGameState } from "../_shared.ts";

export const description = "Add points to the player's score.";

export const parameters = {
  type: "object",
  properties: {
    value: { type: "number", description: "Points to add" },
  },
  required: ["value"],
};

export default async function execute(
  args: { value: number },
  ctx: {
    kv: {
      get: <T>(key: string) => Promise<T | null>;
      set: (key: string, value: unknown) => Promise<void>;
    };
  },
) {
  const g = await getGameState(ctx.kv);
  g.score += args.value;
  await saveGameState(ctx.kv, g);
  return { score: g.score };
}
