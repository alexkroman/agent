export const description = "Move to the next research phase (gather -> analyze -> respond)";

export default async function execute(
  _args: Record<string, never>,
  ctx: {
    kv: {
      get: <T>(k: string) => Promise<T | undefined>;
      set: (k: string, v: unknown) => Promise<void>;
    };
  },
) {
  const phase: string = (await ctx.kv.get("phase")) ?? "gather";
  let nextPhase: string;

  if (phase === "gather") {
    nextPhase = "analyze";
  } else if (phase === "analyze") {
    nextPhase = "respond";
  } else {
    nextPhase = phase;
  }

  await ctx.kv.set("phase", nextPhase);
  return { phase: nextPhase };
}
