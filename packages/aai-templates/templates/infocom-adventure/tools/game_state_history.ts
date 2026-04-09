import { getGameState, saveGameState } from "../_shared.ts";

export const description = "Log a player command to the history and increment the move counter.";

export const parameters = {
  type: "object",
  properties: {
    value: { type: "string", description: "Command text to log" },
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
  g.history.push(args.value);
  g.moves++;
  await saveGameState(ctx.kv, g);
  return { moves: g.moves, recentHistory: g.history.slice(-5) };
}
