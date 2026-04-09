import { getGameState, saveGameState } from "../_shared.ts";

export const description = "Set a game flag to true, used for tracking puzzle and event state.";

export const parameters = {
  type: "object",
  properties: {
    value: { type: "string", description: "Flag name to set" },
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
  g.flags[args.value] = true;
  await saveGameState(ctx.kv, g);
  return { flags: g.flags };
}
